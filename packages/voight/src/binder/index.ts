import {
    type BoundCommonTableExpression,
    type BoundExpression,
    type BoundJoin,
    type BoundLimitClause,
    type BoundOrderByItem,
    type BoundOutputColumn,
    type BoundQuery,
    type BoundScope,
    type BoundSelectExpressionItem,
    type BoundSelectItem,
    type BoundSelectStatement,
    type BoundSelectWildcardItem,
    type BoundTableReference,
    type BoundWithClause,
    type CommonTableExpressionNode,
    type DerivedTableReferenceNode,
    type ExpressionNode,
    type QueryAst,
    type SelectItemNode,
    type SelectStatementAst,
    type TableReferenceNode,
    type WithClauseNode,
} from "../ast";
import { type Catalog, normalizeIdentifier } from "../catalog";
import {
    bindExpressionNode,
    bindLimitClause,
    bindOrderByExpressionNode,
    type BinderExpressionContext,
} from "./expression";
import {
    createQueryTableSchema,
    deriveOutputColumn,
    expandWildcardColumns,
    findNonSelectableProjectionReference,
} from "./output";
import {
    CompilerStage,
    DiagnosticCode,
    DiagnosticVisibility,
    createDiagnostic,
} from "../core/diagnostics";
import { stageFailure, stageSuccess, type StageResult } from "../core/result";
import type { SourceSpan } from "../core/source";

export type BindResult<T> = StageResult<T, CompilerStage.Binder, { scopeSize: number }>;

interface BinderScopeFrame {
    readonly tables: Map<string, BoundTableReference>;
    readonly parent?: BinderScopeFrame;
}

interface BinderContext {
    readonly ctes: Map<string, BoundCommonTableExpression>;
    readonly parentScope?: BinderScopeFrame;
}

export function bind(ast: QueryAst, catalog: Catalog): BindResult<BoundQuery> {
    const binder = new Binder(ast, catalog, {
        ctes: new Map(),
    });
    return binder.bindQuery();
}

class Binder {
    readonly #ast: QueryAst | SelectStatementAst;
    readonly #catalog: Catalog;
    readonly #context: BinderContext;
    readonly #scope: BinderScopeFrame;
    readonly #selectAliases = new Map<string, BoundExpression>();
    readonly #expressionContext: BinderExpressionContext;

    constructor(ast: QueryAst | SelectStatementAst, catalog: Catalog, context: BinderContext) {
        this.#ast = ast;
        this.#catalog = catalog;
        this.#context = context;
        this.#scope = {
            tables: new Map(),
            parent: context.parentScope,
        };
        this.#expressionContext = {
            catalog: this.#catalog,
            scopeSize: () => this.#scope.tables.size,
            bindExpression: (node) => this.bindExpression(node),
            bindSubquery: (query) => this.bindCorrelatedSubquery(query),
            resolveTableAlias: (alias, span) => this.resolveTableAlias(alias, span),
            visibleTables: () => this.visibleTables(),
            selectAlias: (name) => this.#selectAliases.get(name),
            fail: (code, message, span) => this.fail(code, message, span),
        };
    }

    bindQuery(): BindResult<BoundQuery> {
        if (this.#ast.kind !== "Query") {
            throw new Error("bindQuery requires a Query AST.");
        }

        const withClause = this.#ast.with ? this.bindWithClause(this.#ast.with) : undefined;
        if (withClause && !withClause.ok) {
            return withClause;
        }

        const bodyBinder = new Binder(this.#ast.body, this.#catalog, {
            ctes: withClause?.value
                ? new Map(withClause.value.ctes.map((cte) => [cte.name, cte]))
                : this.#context.ctes,
            parentScope: this.#context.parentScope,
        });
        const body = bodyBinder.bindSelectStatement();
        if (!body.ok) {
            return body;
        }

        return stageSuccess(
            CompilerStage.Binder,
            {
                kind: "BoundQuery",
                span: this.#ast.span,
                ast: this.#ast,
                with: withClause?.value,
                body: body.value,
                output: body.value.output,
            },
            { scopeSize: body.value.scope.tables.size },
        );
    }

    bindWithClause(node: WithClauseNode): BindResult<BoundWithClause> {
        const ctes: BoundCommonTableExpression[] = [];
        const cteMap = new Map(this.#context.ctes);

        for (const cte of node.ctes) {
            const boundCte = this.bindCommonTableExpression(cte, cteMap);
            if (!boundCte.ok) {
                return boundCte;
            }

            ctes.push(boundCte.value);
            cteMap.set(boundCte.value.name, boundCte.value);
        }

        return stageSuccess(
            CompilerStage.Binder,
            {
                kind: "BoundWithClause",
                span: node.span,
                ast: node,
                ctes,
            },
            { scopeSize: this.#scope.tables.size },
        );
    }

    bindCommonTableExpression(
        node: CommonTableExpressionNode,
        visibleCtes: Map<string, BoundCommonTableExpression>,
    ): BindResult<BoundCommonTableExpression> {
        const name = normalizeIdentifier(node.name.name);
        if (visibleCtes.has(name)) {
            return this.fail(
                DiagnosticCode.DuplicateAlias,
                `Duplicate CTE name "${name}".`,
                node.name.span,
            );
        }

        const queryBinder = new Binder(node.query, this.#catalog, {
            ctes: visibleCtes,
            parentScope: undefined,
        });
        const query = queryBinder.bindQuery();
        if (!query.ok) {
            return query;
        }

        if (node.columns.length > 0 && node.columns.length !== query.value.output.length) {
            return this.fail(
                DiagnosticCode.InvalidColumnArity,
                `CTE "${name}" declares ${node.columns.length} columns but query produces ${query.value.output.length}.`,
                node.span,
            );
        }

        const table = createQueryTableSchema(name, query.value, node.columns);
        return stageSuccess(
            CompilerStage.Binder,
            {
                kind: "BoundCommonTableExpression",
                span: node.span,
                ast: node,
                name,
                query: query.value,
                table,
            },
            { scopeSize: this.#scope.tables.size },
        );
    }

    bindSelectStatement(): BindResult<BoundSelectStatement> {
        if (this.#ast.kind !== "SelectStatement") {
            throw new Error("bindSelectStatement requires a SelectStatement AST.");
        }

        const from = this.#ast.from ? this.bindTableReference(this.#ast.from) : undefined;
        if (from && !from.ok) {
            return from;
        }

        if (from?.value) {
            this.#scope.tables.set(from.value.alias, from.value);
        }

        const joins: BoundJoin[] = [];
        for (const join of this.#ast.joins) {
            const boundTable = this.bindTableReference(join.table);
            if (!boundTable.ok) {
                return boundTable;
            }

            if (this.#scope.tables.has(boundTable.value.alias)) {
                return this.fail(
                    DiagnosticCode.DuplicateAlias,
                    `Duplicate table alias "${boundTable.value.alias}".`,
                    join.table.span,
                );
            }

            this.#scope.tables.set(boundTable.value.alias, boundTable.value);
            const boundOn = this.bindExpression(join.on);
            if (!boundOn.ok) {
                return boundOn;
            }

            joins.push({
                kind: "BoundJoin",
                span: join.span,
                ast: join,
                joinType: join.joinType,
                table: boundTable.value,
                on: boundOn.value,
            });
        }

        const boundSelectItems: BoundSelectItem[] = [];
        const output: BoundOutputColumn[] = [];
        for (const item of this.#ast.selectItems) {
            const boundItem = this.bindSelectItem(item);
            if (!boundItem.ok) {
                return boundItem;
            }

            boundSelectItems.push(boundItem.value);
            if (boundItem.value.kind === "BoundSelectExpressionItem" && boundItem.value.alias) {
                this.#selectAliases.set(boundItem.value.alias, boundItem.value.expression);
            }

            if (boundItem.value.kind === "BoundSelectWildcardItem") {
                output.push(...boundItem.value.columns);
            } else {
                const column = deriveOutputColumn(boundItem.value, output.length);
                if (column) {
                    output.push(column);
                }
            }
        }

        const where = this.#ast.where ? this.bindExpression(this.#ast.where) : undefined;
        if (where && !where.ok) {
            return where;
        }

        const groupBy: BoundExpression[] = [];
        for (const expression of this.#ast.groupBy) {
            const bound = this.bindExpression(expression);
            if (!bound.ok) {
                return bound;
            }
            groupBy.push(bound.value);
        }

        const having = this.#ast.having ? this.bindExpression(this.#ast.having) : undefined;
        if (having && !having.ok) {
            return having;
        }

        const orderBy: BoundOrderByItem[] = [];
        for (const item of this.#ast.orderBy) {
            const bound = this.bindOrderByExpression(item.expression);
            if (!bound.ok) {
                return bound;
            }

            orderBy.push({
                kind: "BoundOrderByItem",
                span: item.span,
                ast: item,
                expression: bound.value,
                direction: item.direction,
            });
        }

        const limit = this.#ast.limit ? this.bindLimit(this.#ast.limit) : undefined;
        if (limit && !limit.ok) {
            return limit;
        }

        const scope: BoundScope = {
            tables: new Map(this.#scope.tables),
            ctes: new Map(this.#context.ctes),
        };

        return stageSuccess(
            CompilerStage.Binder,
            {
                kind: "BoundSelectStatement",
                span: this.#ast.span,
                ast: this.#ast,
                selectItems: boundSelectItems,
                from: from?.value,
                joins,
                where: where?.value,
                groupBy,
                having: having?.value,
                orderBy,
                limit: limit?.value,
                scope,
                output,
            },
            { scopeSize: scope.tables.size },
        );
    }

    bindTableReference(node: TableReferenceNode): BindResult<BoundTableReference> {
        if (node.kind === "DerivedTableReference") {
            return this.bindDerivedTableReference(node);
        }

        const path = {
            parts: node.name.parts.map((part) => normalizeIdentifier(part.name)),
        };

        const cteName = path.parts.length === 1 ? path.parts[0] : undefined;
        if (cteName) {
            const cte = this.#context.ctes.get(cteName);
            if (cte) {
                return stageSuccess(
                    CompilerStage.Binder,
                    {
                        kind: "BoundTableReference",
                        span: node.span,
                        ast: node,
                        table: cte.table,
                        alias: normalizeIdentifier(node.alias?.name ?? cte.name),
                        source: "cte",
                        subquery: cte.query,
                    },
                    { scopeSize: this.#scope.tables.size + 1 },
                );
            }
        }

        const table = this.#catalog.getTable(path);
        if (!table) {
            return this.fail(
                DiagnosticCode.UnknownTable,
                `Unknown table "${node.name.parts.map((part) => part.name).join(".")}".`,
                node.name.span,
            );
        }

        return stageSuccess(
            CompilerStage.Binder,
            {
                kind: "BoundTableReference",
                span: node.span,
                ast: node,
                table,
                alias: normalizeIdentifier(
                    node.alias?.name ??
                        node.name.parts[node.name.parts.length - 1]?.name ??
                        table.name,
                ),
                source: "catalog",
            },
            { scopeSize: this.#scope.tables.size + 1 },
        );
    }

    bindDerivedTableReference(node: DerivedTableReferenceNode): BindResult<BoundTableReference> {
        const queryBinder = new Binder(node.subquery, this.#catalog, {
            ctes: this.#context.ctes,
            parentScope: undefined,
        });
        const subquery = queryBinder.bindQuery();
        if (!subquery.ok) {
            return subquery;
        }

        const alias = normalizeIdentifier(node.alias.name);
        const table = createQueryTableSchema(alias, subquery.value);

        return stageSuccess(
            CompilerStage.Binder,
            {
                kind: "BoundTableReference",
                span: node.span,
                ast: node,
                table,
                alias,
                source: "derived",
                subquery: subquery.value,
            },
            { scopeSize: this.#scope.tables.size + 1 },
        );
    }

    bindSelectItem(node: SelectItemNode): BindResult<BoundSelectItem> {
        if (node.kind === "SelectWildcardItem") {
            const table = node.qualifier
                ? this.resolveTableAlias(node.qualifier.name, node.qualifier.span)
                : undefined;
            if (table && !table.ok) {
                return table;
            }

            const columns = expandWildcardColumns(table?.value, this.visibleTables());
            if (columns.length === 0) {
                return this.fail(
                    DiagnosticCode.NonSelectableColumn,
                    node.qualifier
                        ? `Wildcard "${node.qualifier.name}.*" does not expose any selectable columns.`
                        : "Wildcard does not expose any selectable columns.",
                    node.span,
                );
            }

            return stageSuccess(
                CompilerStage.Binder,
                {
                    kind: "BoundSelectWildcardItem",
                    span: node.span,
                    ast: node,
                    table: table?.value,
                    columns,
                } satisfies BoundSelectWildcardItem,
                { scopeSize: this.#scope.tables.size },
            );
        }

        const expression = this.bindExpression(node.expression);
        if (!expression.ok) {
            return expression;
        }

        const hiddenProjection = findNonSelectableProjectionReference(expression.value);
        if (hiddenProjection) {
            return stageFailure(
                CompilerStage.Binder,
                [
                    createNonSelectableColumnDiagnostic(
                        `Column "${hiddenProjection.column.name}" cannot be projected.`,
                        hiddenProjection.span,
                    ),
                ],
                { scopeSize: this.#scope.tables.size },
            );
        }

        return stageSuccess(
            CompilerStage.Binder,
            {
                kind: "BoundSelectExpressionItem",
                span: node.span,
                ast: node,
                expression: expression.value,
                alias: node.alias ? normalizeIdentifier(node.alias.name) : undefined,
            } satisfies BoundSelectExpressionItem,
            { scopeSize: this.#scope.tables.size },
        );
    }

    bindLimit(node: BoundLimitClause["ast"]): BindResult<BoundLimitClause> {
        return bindLimitClause(this.#expressionContext, node);
    }

    bindOrderByExpression(node: ExpressionNode): BindResult<BoundExpression> {
        return bindOrderByExpressionNode(this.#expressionContext, node);
    }

    bindExpression(node: ExpressionNode): BindResult<BoundExpression> {
        return bindExpressionNode(this.#expressionContext, node);
    }

    bindCorrelatedSubquery(query: QueryAst): BindResult<BoundQuery> {
        const queryBinder = new Binder(query, this.#catalog, {
            ctes: this.#context.ctes,
            parentScope: this.#scope,
        });
        return queryBinder.bindQuery();
    }

    resolveTableAlias(alias: string, span: SourceSpan): BindResult<BoundTableReference> {
        for (let frame: BinderScopeFrame | undefined = this.#scope; frame; frame = frame.parent) {
            const bound = frame.tables.get(normalizeIdentifier(alias));
            if (bound) {
                return stageSuccess(CompilerStage.Binder, bound, {
                    scopeSize: this.#scope.tables.size,
                });
            }
        }

        return this.fail(DiagnosticCode.UnknownTable, `Unknown table or alias "${alias}".`, span);
    }

    visibleTables(): BoundTableReference[] {
        const merged = new Map<string, BoundTableReference>();
        const frames: BinderScopeFrame[] = [];
        for (let frame: BinderScopeFrame | undefined = this.#scope; frame; frame = frame.parent) {
            frames.unshift(frame);
        }

        for (const frame of frames) {
            for (const [alias, table] of frame.tables) {
                merged.set(alias, table);
            }
        }

        return [...merged.values()];
    }

    fail(code: DiagnosticCode, message: string, span: SourceSpan): BindResult<never> {
        return stageFailure(
            CompilerStage.Binder,
            [
                code === DiagnosticCode.NonSelectableColumn
                    ? createNonSelectableColumnDiagnostic(message, span)
                    : createDiagnostic({
                          code,
                          stage: CompilerStage.Binder,
                          message,
                          primarySpan: span,
                      }),
            ],
            { scopeSize: this.#scope.tables.size },
        );
    }
}

function createNonSelectableColumnDiagnostic(message: string, span: SourceSpan) {
    return createDiagnostic({
        code: DiagnosticCode.NonSelectableColumn,
        stage: CompilerStage.Binder,
        message,
        primarySpan: span,
        visibility: DiagnosticVisibility.PublicRedacted,
        publicCode: DiagnosticCode.UnknownColumn,
        publicMessage: "Query references columns that are not available.",
    });
}
