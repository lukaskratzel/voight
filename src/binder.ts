import {
    type BinaryExpressionNode,
    type BoundBinaryExpression,
    type BoundColumnReference,
    type BoundCurrentKeywordExpression,
    type BoundExpression,
    type BoundFunctionCall,
    type BoundGroupingExpression,
    type BoundInListExpression,
    type BoundIsNullExpression,
    type BoundJoin,
    type BoundLimitClause,
    type BoundLiteral,
    type BoundOrderByItem,
    type BoundParameter,
    type BoundScope,
    type BoundSelectExpressionItem,
    type BoundSelectItem,
    type BoundSelectStatement,
    type BoundSelectWildcardItem,
    type BoundTableReference,
    type BoundUnaryExpression,
    type BoundWildcardExpression,
    type DerivedTableReferenceNode,
    type ExpressionNode,
    type GroupingExpressionNode,
    type IdentifierExpressionNode,
    type InListExpressionNode,
    type IsNullExpressionNode,
    type QualifiedReferenceNode,
    type SelectExpressionItemNode,
    type SelectItemNode,
    type SelectStatementAst,
    type SelectWildcardItemNode,
    type TableReferenceNode,
    type UnaryExpressionNode,
    type WildcardExpressionNode,
} from "./ast";
import { type Catalog, normalizeIdentifier, type ColumnSchema, type TableSchema } from "./catalog";
import { CompilerStage, DiagnosticCode, createDiagnostic, type Diagnostic } from "./diagnostics";
import { stageFailure, stageSuccess, type StageResult } from "./result";
import type { SourceSpan } from "./source";

export type BindResult<T> = StageResult<T, CompilerStage.Binder, { scopeSize: number }>;

interface BinderScope {
    readonly tables: Map<string, BoundTableReference>;
}

export function bind(ast: SelectStatementAst, catalog: Catalog): BindResult<BoundSelectStatement> {
    const binder = new Binder(ast, catalog);
    return binder.bind();
}

class Binder {
    readonly #ast: SelectStatementAst;
    readonly #catalog: Catalog;
    readonly #scope: BinderScope = {
        tables: new Map(),
    };
    readonly #selectAliases = new Map<string, BoundExpression>();

    constructor(ast: SelectStatementAst, catalog: Catalog) {
        this.#ast = ast;
        this.#catalog = catalog;
    }

    bind(): BindResult<BoundSelectStatement> {
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
        for (const item of this.#ast.selectItems) {
            const boundItem = this.bindSelectItem(item);
            if (!boundItem.ok) {
                return boundItem;
            }
            boundSelectItems.push(boundItem.value);
            if (boundItem.value.kind === "BoundSelectExpressionItem" && boundItem.value.alias) {
                this.#selectAliases.set(boundItem.value.alias, boundItem.value.expression);
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
                alias: normalizeIdentifier(node.alias?.name ?? table.name),
                source: "catalog",
            },
            { scopeSize: this.#scope.tables.size + 1 },
        );
    }

    bindDerivedTableReference(node: DerivedTableReferenceNode): BindResult<BoundTableReference> {
        const nestedBinder = new Binder(node.subquery, this.#catalog);
        const subquery = nestedBinder.bind();
        if (!subquery.ok) {
            return subquery;
        }

        const alias = normalizeIdentifier(node.alias.name);
        const table = createDerivedTableSchema(alias, subquery.value);

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

            return stageSuccess(
                CompilerStage.Binder,
                {
                    kind: "BoundSelectWildcardItem",
                    span: node.span,
                    ast: node,
                    table: table?.value,
                } satisfies BoundSelectWildcardItem,
                { scopeSize: this.#scope.tables.size },
            );
        }

        const expression = this.bindExpression(node.expression);
        if (!expression.ok) {
            return expression;
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
        const count = this.bindExpression(node.count);
        if (!count.ok) {
            return count;
        }

        const offset = node.offset ? this.bindExpression(node.offset) : undefined;
        if (offset && !offset.ok) {
            return offset;
        }

        return stageSuccess(
            CompilerStage.Binder,
            {
                kind: "BoundLimitClause",
                span: node.span,
                ast: node,
                count: count.value,
                offset: offset?.value,
            },
            { scopeSize: this.#scope.tables.size },
        );
    }

    bindOrderByExpression(node: ExpressionNode): BindResult<BoundExpression> {
        if (node.kind === "IdentifierExpression") {
            const alias = this.#selectAliases.get(normalizeIdentifier(node.identifier.name));
            if (alias) {
                return stageSuccess(CompilerStage.Binder, alias, {
                    scopeSize: this.#scope.tables.size,
                });
            }
        }

        return this.bindExpression(node);
    }

    bindExpression(node: ExpressionNode): BindResult<BoundExpression> {
        switch (node.kind) {
            case "Literal":
                return stageSuccess(
                    CompilerStage.Binder,
                    {
                        kind: "BoundLiteral",
                        span: node.span,
                        ast: node,
                        literalType: node.literalType,
                        value: node.value,
                    } satisfies BoundLiteral,
                    { scopeSize: this.#scope.tables.size },
                );
            case "Parameter":
                return stageSuccess(
                    CompilerStage.Binder,
                    {
                        kind: "BoundParameter",
                        span: node.span,
                        ast: node,
                        index: node.index,
                    } satisfies BoundParameter,
                    { scopeSize: this.#scope.tables.size },
                );
            case "IdentifierExpression":
                return this.bindUnqualifiedColumn(node);
            case "QualifiedReference":
                return this.bindQualifiedColumn(node);
            case "UnaryExpression":
                return this.bindUnary(node);
            case "BinaryExpression":
                return this.bindBinary(node);
            case "FunctionCall":
                return this.bindFunction(node);
            case "GroupingExpression":
                return this.bindGrouping(node);
            case "WildcardExpression":
                return this.bindWildcard(node);
            case "IsNullExpression":
                return this.bindIsNull(node);
            case "CurrentKeywordExpression":
                return stageSuccess(
                    CompilerStage.Binder,
                    {
                        kind: "BoundCurrentKeywordExpression",
                        span: node.span,
                        ast: node,
                        keyword: node.keyword,
                    } satisfies BoundCurrentKeywordExpression,
                    { scopeSize: this.#scope.tables.size },
                );
            case "InListExpression":
                return this.bindInList(node);
        }
    }

    bindUnary(node: UnaryExpressionNode): BindResult<BoundUnaryExpression> {
        const operand = this.bindExpression(node.operand);
        if (!operand.ok) {
            return operand;
        }

        return stageSuccess(
            CompilerStage.Binder,
            {
                kind: "BoundUnaryExpression",
                span: node.span,
                ast: node,
                operator: node.operator,
                operand: operand.value,
            },
            { scopeSize: this.#scope.tables.size },
        );
    }

    bindBinary(node: BinaryExpressionNode): BindResult<BoundBinaryExpression> {
        const left = this.bindExpression(node.left);
        if (!left.ok) {
            return left;
        }

        const right = this.bindExpression(node.right);
        if (!right.ok) {
            return right;
        }

        return stageSuccess(
            CompilerStage.Binder,
            {
                kind: "BoundBinaryExpression",
                span: node.span,
                ast: node,
                operator: node.operator,
                left: left.value,
                right: right.value,
            },
            { scopeSize: this.#scope.tables.size },
        );
    }

    bindFunction(node: BoundFunctionCall["ast"]): BindResult<BoundFunctionCall> {
        const args: BoundExpression[] = [];
        for (const arg of node.arguments) {
            const bound = this.bindExpression(arg);
            if (!bound.ok) {
                return bound;
            }
            args.push(bound.value);
        }

        return stageSuccess(
            CompilerStage.Binder,
            {
                kind: "BoundFunctionCall",
                span: node.span,
                ast: node,
                callee: normalizeIdentifier(node.callee.name),
                arguments: args,
            },
            { scopeSize: this.#scope.tables.size },
        );
    }

    bindGrouping(node: GroupingExpressionNode): BindResult<BoundGroupingExpression> {
        const expression = this.bindExpression(node.expression);
        if (!expression.ok) {
            return expression;
        }

        return stageSuccess(
            CompilerStage.Binder,
            {
                kind: "BoundGroupingExpression",
                span: node.span,
                ast: node,
                expression: expression.value,
            },
            { scopeSize: this.#scope.tables.size },
        );
    }

    bindWildcard(node: WildcardExpressionNode): BindResult<BoundWildcardExpression> {
        const table = node.qualifier
            ? this.resolveTableAlias(node.qualifier.name, node.qualifier.span)
            : undefined;
        if (table && !table.ok) {
            return table;
        }

        return stageSuccess(
            CompilerStage.Binder,
            {
                kind: "BoundWildcardExpression",
                span: node.span,
                ast: node,
                table: table?.value,
            },
            { scopeSize: this.#scope.tables.size },
        );
    }

    bindIsNull(node: IsNullExpressionNode): BindResult<BoundIsNullExpression> {
        const operand = this.bindExpression(node.operand);
        if (!operand.ok) {
            return operand;
        }

        return stageSuccess(
            CompilerStage.Binder,
            {
                kind: "BoundIsNullExpression",
                span: node.span,
                ast: node,
                operand: operand.value,
                negated: node.negated,
            },
            { scopeSize: this.#scope.tables.size },
        );
    }

    bindInList(node: InListExpressionNode): BindResult<BoundInListExpression> {
        const operand = this.bindExpression(node.operand);
        if (!operand.ok) {
            return operand;
        }

        const values: BoundExpression[] = [];
        for (const value of node.values) {
            const boundValue = this.bindExpression(value);
            if (!boundValue.ok) {
                return boundValue;
            }
            values.push(boundValue.value);
        }

        return stageSuccess(
            CompilerStage.Binder,
            {
                kind: "BoundInListExpression",
                span: node.span,
                ast: node,
                operand: operand.value,
                values,
                negated: node.negated,
            } satisfies BoundInListExpression,
            { scopeSize: this.#scope.tables.size },
        );
    }

    bindQualifiedColumn(node: QualifiedReferenceNode): BindResult<BoundColumnReference> {
        const table = this.resolveTableAlias(node.qualifier.name, node.qualifier.span);
        if (!table.ok) {
            return table;
        }

        const column = this.#catalog.resolveColumn(
            table.value.table,
            normalizeIdentifier(node.column.name),
        );
        if (!column) {
            return this.fail(
                DiagnosticCode.UnknownColumn,
                `Unknown column "${node.column.name}" on table "${table.value.alias}".`,
                node.column.span,
            );
        }

        return stageSuccess(
            CompilerStage.Binder,
            {
                kind: "BoundColumnReference",
                span: node.span,
                ast: node,
                table: table.value,
                column,
            },
            { scopeSize: this.#scope.tables.size },
        );
    }

    bindUnqualifiedColumn(node: IdentifierExpressionNode): BindResult<BoundColumnReference> {
        const matches = [...this.#scope.tables.values()]
            .map((table) => ({
                table,
                column: this.#catalog.resolveColumn(
                    table.table,
                    normalizeIdentifier(node.identifier.name),
                ),
            }))
            .filter(
                (
                    match,
                ): match is {
                    table: BoundTableReference;
                    column: NonNullable<ReturnType<Catalog["resolveColumn"]>>;
                } => match.column !== null,
            );

        if (matches.length === 0) {
            return this.fail(
                DiagnosticCode.UnknownColumn,
                `Unknown column "${node.identifier.name}".`,
                node.identifier.span,
            );
        }

        if (matches.length > 1) {
            return stageFailure(
                CompilerStage.Binder,
                [
                    createDiagnostic({
                        code: DiagnosticCode.AmbiguousColumn,
                        stage: CompilerStage.Binder,
                        message: `Ambiguous column "${node.identifier.name}".`,
                        primarySpan: node.identifier.span,
                        relatedSpans: matches.map((match) => ({
                            message: `Matched table alias "${match.table.alias}".`,
                            span: match.table.span,
                        })),
                    }),
                ],
                { scopeSize: this.#scope.tables.size },
            );
        }

        const match = matches[0]!;

        return stageSuccess(
            CompilerStage.Binder,
            {
                kind: "BoundColumnReference",
                span: node.span,
                ast: node,
                table: match.table,
                column: match.column,
            },
            { scopeSize: this.#scope.tables.size },
        );
    }

    resolveTableAlias(alias: string, span: SourceSpan): BindResult<BoundTableReference> {
        const bound = this.#scope.tables.get(normalizeIdentifier(alias));
        if (!bound) {
            return this.fail(
                DiagnosticCode.UnknownTable,
                `Unknown table or alias "${alias}".`,
                span,
            );
        }

        return stageSuccess(CompilerStage.Binder, bound, {
            scopeSize: this.#scope.tables.size,
        });
    }

    fail(code: DiagnosticCode, message: string, span: SourceSpan): BindResult<never> {
        return stageFailure(
            CompilerStage.Binder,
            [
                createDiagnostic({
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

function createDerivedTableSchema(alias: string, statement: BoundSelectStatement): TableSchema {
    const columns = new Map<string, ColumnSchema>();

    for (const item of statement.selectItems) {
        if (item.kind !== "BoundSelectExpressionItem") {
            continue;
        }

        const columnName = deriveSelectItemName(item);
        if (!columnName) {
            continue;
        }

        const normalized = normalizeIdentifier(columnName);
        columns.set(normalized, {
            id: `${alias}.${normalized}`,
            name: normalized,
        });
    }

    return {
        id: `derived:${alias}`,
        name: alias,
        path: {
            parts: [alias],
        },
        columns,
    };
}

function deriveSelectItemName(item: BoundSelectExpressionItem): string | null {
    if (item.alias) {
        return item.alias;
    }

    const expression = item.ast.expression;
    if (expression.kind === "IdentifierExpression") {
        return expression.identifier.name;
    }

    if (expression.kind === "QualifiedReference") {
        return expression.column.name;
    }

    return null;
}
