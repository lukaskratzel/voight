import type {
    BinaryExpressionNode,
    BoundExpression,
    BoundQuery,
    BoundSelectStatement,
    ExpressionNode,
    IdentifierNode,
    LiteralNode,
    QueryAst,
    QualifiedReferenceNode,
    SelectStatementAst,
    TableReferenceNode,
} from "./ast";
import { normalizeIdentifier } from "./catalog";
import { CompilerStage, DiagnosticCode, createDiagnostic, type Diagnostic } from "./diagnostics";
import { mergeSpans, type SourceSpan } from "./source";
import type { QueryAnalysis } from "./analyzer";

export type PolicyContext = Readonly<Record<string, unknown>>;

export interface PolicyRewriteContext {
    readonly context: PolicyContext;
}

export interface PolicyEnforcementContext {
    readonly context: PolicyContext;
    readonly analysis: QueryAnalysis;
}

export interface CompilerPolicy {
    readonly name: string;
    rewrite?(query: QueryAst, context: PolicyRewriteContext): QueryAst;
    enforce?(bound: BoundQuery, context: PolicyEnforcementContext): readonly Diagnostic[];
}

export interface TenantScopingPolicyOptions {
    readonly tables: readonly string[];
    readonly scopeColumn: string;
    readonly contextKey: string;
}

export function tenantScopingPolicy(options: TenantScopingPolicyOptions): CompilerPolicy {
    return new TenantScopingPolicy(options);
}

class TenantScopingPolicy implements CompilerPolicy {
    readonly name = "tenant-scoping";
    readonly #tables: ReadonlySet<string>;
    readonly #scopeColumn: string;
    readonly #contextKey: string;

    constructor(options: TenantScopingPolicyOptions) {
        this.#tables = new Set(options.tables.map(normalizeIdentifier));
        this.#scopeColumn = normalizeIdentifier(options.scopeColumn);
        this.#contextKey = options.contextKey;
    }

    rewrite(query: QueryAst, context: PolicyRewriteContext): QueryAst {
        const value = context.context[this.#contextKey];
        if (typeof value === "undefined") {
            throw new Error(
                `Policy "${this.name}" requires policyContext.${this.#contextKey} to rewrite tenant predicates.`,
            );
        }

        return rewriteQuery(query, (select) => this.#rewriteSelect(select, value));
    }

    enforce(bound: BoundQuery, context: PolicyEnforcementContext): readonly Diagnostic[] {
        const value = context.context[this.#contextKey];
        if (typeof value === "undefined") {
            return [
                createDiagnostic({
                    code: DiagnosticCode.PolicyViolation,
                    stage: CompilerStage.Enforcer,
                    message: `Policy "${this.name}" requires policyContext.${this.#contextKey}.`,
                    primarySpan: bound.span,
                }),
            ];
        }

        const diagnostics: Diagnostic[] = [];

        const visitBoundExpression = (expression: BoundExpression): void => {
            switch (expression.kind) {
                case "BoundInSubqueryExpression":
                    visitBoundExpression(expression.operand);
                    visitQuery(expression.query);
                    return;
                case "BoundExistsExpression":
                case "BoundScalarSubqueryExpression":
                    visitQuery(expression.query);
                    return;
                case "BoundBinaryExpression":
                    visitBoundExpression(expression.left);
                    visitBoundExpression(expression.right);
                    return;
                case "BoundUnaryExpression":
                    visitBoundExpression(expression.operand);
                    return;
                case "BoundGroupingExpression":
                    visitBoundExpression(expression.expression);
                    return;
                case "BoundIsNullExpression":
                    visitBoundExpression(expression.operand);
                    return;
                case "BoundInListExpression":
                    visitBoundExpression(expression.operand);
                    expression.values.forEach(visitBoundExpression);
                    return;
                case "BoundFunctionCall":
                    expression.arguments.forEach(visitBoundExpression);
                    return;
                default:
                    return;
            }
        };

        const visitQuery = (query: BoundQuery): void => {
            query.with?.ctes.forEach((cte) => visitQuery(cte.query));
            this.#enforceSelect(query.body, diagnostics, value);
            query.body.joins.forEach((join) => {
                if (join.table.source === "derived" && join.table.subquery) {
                    visitQuery(join.table.subquery);
                }
                visitBoundExpression(join.on);
            });
            if (query.body.from?.source === "derived" && query.body.from.subquery) {
                visitQuery(query.body.from.subquery);
            }
            const body = query.body;
            body.selectItems.forEach((item) => {
                if (item.kind === "BoundSelectExpressionItem") {
                    visitBoundExpression(item.expression);
                }
            });
            body.where && visitBoundExpression(body.where);
            body.groupBy.forEach(visitBoundExpression);
            body.having && visitBoundExpression(body.having);
            body.orderBy.forEach((item) => visitBoundExpression(item.expression));
        };

        visitQuery(bound);
        return diagnostics;
    }

    #rewriteSelect(select: SelectStatementAst, value: unknown): SelectStatementAst {
        const fromScope = select.from
            ? resolveScopedTableAlias(select.from, this.#tables)
            : undefined;
        const joins = select.joins.map((join) => {
            const scope = resolveScopedTableAlias(join.table, this.#tables);
            if (!scope) {
                return join;
            }

            const predicate = createTenantPredicate(
                scope.alias,
                this.#scopeColumn,
                value,
                scope.span,
            );
            return {
                ...join,
                on: combinePredicates([join.on, predicate]),
                span: mergeSpans(join.span, predicate.span),
            };
        });

        const where = fromScope
            ? select.where
                ? combinePredicates([
                      select.where,
                      createTenantPredicate(
                          fromScope.alias,
                          this.#scopeColumn,
                          value,
                          fromScope.span,
                      ),
                  ])
                : createTenantPredicate(fromScope.alias, this.#scopeColumn, value, fromScope.span)
            : select.where;

        return {
            ...select,
            joins,
            where,
            span: where ? mergeSpans(select.span, where.span) : select.span,
        };
    }

    #enforceSelect(select: BoundSelectStatement, diagnostics: Diagnostic[], value: unknown): void {
        const expectedLiteral = normalizePolicyValue(value);
        const scopedTables = Array.from(select.scope.tables.values()).filter((table) =>
            this.#tables.has(table.table.name),
        );

        for (const table of scopedTables) {
            const guardExpression =
                select.from?.alias === table.alias
                    ? select.where
                    : select.joins.find((join) => join.table.alias === table.alias)?.on;

            if (
                hasRequiredTenantScope(
                    guardExpression,
                    table.alias,
                    this.#scopeColumn,
                    expectedLiteral,
                )
            ) {
                continue;
            }

            diagnostics.push(
                createDiagnostic({
                    code: DiagnosticCode.PolicyViolation,
                    stage: CompilerStage.Enforcer,
                    message: `Policy "${this.name}" requires ${table.alias}.${this.#scopeColumn} to be scoped.`,
                    primarySpan: table.span,
                }),
            );
        }
    }
}

function rewriteQuery(
    query: QueryAst,
    rewriteSelect: (select: SelectStatementAst) => SelectStatementAst,
): QueryAst {
    const withClause = query.with
        ? {
              ...query.with,
              ctes: query.with.ctes.map((cte) => ({
                  ...cte,
                  query: rewriteQuery(cte.query, rewriteSelect),
              })),
          }
        : undefined;

    return {
        ...query,
        with: withClause,
        body: rewriteSelect(rewriteSelectTables(query.body, rewriteSelect)),
    };
}

function rewriteSelectTables(
    select: SelectStatementAst,
    rewriteSelect: (select: SelectStatementAst) => SelectStatementAst,
): SelectStatementAst {
    const from = select.from ? rewriteTable(select.from, rewriteSelect) : undefined;
    const joins = select.joins.map((join) => ({
        ...join,
        table: rewriteTable(join.table, rewriteSelect),
        on: rewriteExpressionSubqueries(join.on, rewriteSelect),
    }));
    const selectItems = select.selectItems.map((item) =>
        item.kind === "SelectExpressionItem"
            ? { ...item, expression: rewriteExpressionSubqueries(item.expression, rewriteSelect) }
            : item,
    );
    const where = select.where
        ? rewriteExpressionSubqueries(select.where, rewriteSelect)
        : undefined;
    const groupBy = select.groupBy.map((expr) =>
        rewriteExpressionSubqueries(expr, rewriteSelect),
    );
    const having = select.having
        ? rewriteExpressionSubqueries(select.having, rewriteSelect)
        : undefined;
    const orderBy = select.orderBy.map((item) => ({
        ...item,
        expression: rewriteExpressionSubqueries(item.expression, rewriteSelect),
    }));
    const limit = select.limit
        ? {
              ...select.limit,
              count: rewriteExpressionSubqueries(select.limit.count, rewriteSelect),
              offset: select.limit.offset
                  ? rewriteExpressionSubqueries(select.limit.offset, rewriteSelect)
                  : undefined,
          }
        : undefined;

    return {
        ...select,
        selectItems,
        from,
        joins,
        where,
        groupBy,
        having,
        orderBy,
        limit,
    };
}

function rewriteExpressionSubqueries(
    expression: ExpressionNode,
    rewriteSelect: (select: SelectStatementAst) => SelectStatementAst,
): ExpressionNode {
    switch (expression.kind) {
        case "InSubqueryExpression":
            return {
                ...expression,
                operand: rewriteExpressionSubqueries(expression.operand, rewriteSelect),
                query: rewriteQuery(expression.query, rewriteSelect),
            };
        case "ExistsExpression":
            return {
                ...expression,
                query: rewriteQuery(expression.query, rewriteSelect),
            };
        case "ScalarSubqueryExpression":
            return {
                ...expression,
                query: rewriteQuery(expression.query, rewriteSelect),
            };
        case "BinaryExpression":
            return {
                ...expression,
                left: rewriteExpressionSubqueries(expression.left, rewriteSelect),
                right: rewriteExpressionSubqueries(expression.right, rewriteSelect),
            };
        case "UnaryExpression":
            return {
                ...expression,
                operand: rewriteExpressionSubqueries(expression.operand, rewriteSelect),
            };
        case "GroupingExpression":
            return {
                ...expression,
                expression: rewriteExpressionSubqueries(expression.expression, rewriteSelect),
            };
        case "IsNullExpression":
            return {
                ...expression,
                operand: rewriteExpressionSubqueries(expression.operand, rewriteSelect),
            };
        case "InListExpression":
            return {
                ...expression,
                operand: rewriteExpressionSubqueries(expression.operand, rewriteSelect),
                values: expression.values.map((v) =>
                    rewriteExpressionSubqueries(v, rewriteSelect),
                ),
            };
        case "FunctionCall":
            return {
                ...expression,
                arguments: expression.arguments.map((a) =>
                    rewriteExpressionSubqueries(a, rewriteSelect),
                ),
            };
        case "Literal":
        case "Parameter":
        case "IdentifierExpression":
        case "QualifiedReference":
        case "WildcardExpression":
        case "CurrentKeywordExpression":
            return expression;
    }
}

function rewriteTable(
    table: TableReferenceNode,
    rewriteSelect: (select: SelectStatementAst) => SelectStatementAst,
): TableReferenceNode {
    if (table.kind !== "DerivedTableReference") {
        return table;
    }

    return {
        ...table,
        subquery: rewriteQuery(table.subquery, rewriteSelect),
    };
}

function resolveScopedTableAlias(
    table: TableReferenceNode,
    tables: ReadonlySet<string>,
): { alias: string; span: SourceSpan } | undefined {
    if (table.kind !== "TableReference") {
        return undefined;
    }

    const name = normalizeIdentifier(table.name.parts[table.name.parts.length - 1]?.name ?? "");
    if (!tables.has(name)) {
        return undefined;
    }

    return {
        alias: normalizeIdentifier(table.alias?.name ?? name),
        span: table.span,
    };
}

function createTenantPredicate(
    alias: string,
    column: string,
    value: unknown,
    span: SourceSpan,
): BinaryExpressionNode {
    const left = createQualifiedReference(alias, column, span);
    const right = createPolicyValueExpression(value, span);

    return {
        kind: "BinaryExpression",
        span: mergeSpans(left.span, right.span),
        operator: "=",
        left,
        right,
    };
}

function combinePredicates(
    expressions: readonly NonNullable<SelectStatementAst["where"]>[],
): NonNullable<SelectStatementAst["where"]> {
    const [first, ...rest] = expressions;
    if (!first) {
        throw new Error("Cannot combine an empty predicate list.");
    }

    return rest.reduce<NonNullable<SelectStatementAst["where"]>>(
        (left, right) => ({
            kind: "BinaryExpression",
            span: mergeSpans(left.span, right.span),
            operator: "AND",
            left,
            right,
        }),
        first,
    );
}

function createQualifiedReference(
    alias: string,
    column: string,
    span: SourceSpan,
): QualifiedReferenceNode {
    return {
        kind: "QualifiedReference",
        span,
        qualifier: createIdentifier(alias, span),
        column: createIdentifier(column, span),
    };
}

function createIdentifier(name: string, span: SourceSpan): IdentifierNode {
    return {
        kind: "Identifier",
        span,
        name,
        quoted: false,
    };
}

function createPolicyValueExpression(value: unknown, span: SourceSpan): LiteralNode {
    if (
        typeof value === "string" ||
        typeof value === "boolean" ||
        value === null ||
        typeof value === "number"
    ) {
        return createLiteral(value, span);
    }

    throw new Error(`Unsupported policy value for tenant scoping: ${String(value)}.`);
}

function createLiteral(value: string | number | boolean | null, span: SourceSpan): LiteralNode {
    if (typeof value === "number") {
        return {
            kind: "Literal",
            span,
            literalType: Number.isInteger(value) ? "integer" : "decimal",
            value: String(value),
        };
    }

    if (typeof value === "string") {
        return {
            kind: "Literal",
            span,
            literalType: "string",
            value,
        };
    }

    if (typeof value === "boolean") {
        return {
            kind: "Literal",
            span,
            literalType: "boolean",
            value,
        };
    }

    return {
        kind: "Literal",
        span,
        literalType: "null",
        value: null,
    };
}

function hasRequiredTenantScope(
    expression: BoundExpression | undefined,
    alias: string,
    column: string,
    expectedValue: string | boolean | null,
): boolean {
    if (!expression) {
        return false;
    }

    if (isTenantComparison(expression, alias, column, expectedValue)) {
        return true;
    }

    switch (expression.kind) {
        case "BoundBinaryExpression":
            if (expression.operator === "AND") {
                return (
                    hasRequiredTenantScope(expression.left, alias, column, expectedValue) ||
                    hasRequiredTenantScope(expression.right, alias, column, expectedValue)
                );
            }

            if (expression.operator === "OR") {
                return (
                    hasRequiredTenantScope(expression.left, alias, column, expectedValue) &&
                    hasRequiredTenantScope(expression.right, alias, column, expectedValue)
                );
            }

            return false;
        case "BoundGroupingExpression":
            return hasRequiredTenantScope(expression.expression, alias, column, expectedValue);
        default:
            return false;
    }
}

function isTenantComparison(
    expression: BoundExpression,
    alias: string,
    column: string,
    expectedValue: string | boolean | null,
): boolean {
    if (expression.kind !== "BoundBinaryExpression" || expression.operator !== "=") {
        return false;
    }

    return (
        (isScopedColumnReference(expression.left, alias, column) &&
            isExpectedLiteral(expression.right, expectedValue)) ||
        (isScopedColumnReference(expression.right, alias, column) &&
            isExpectedLiteral(expression.left, expectedValue))
    );
}

function isScopedColumnReference(
    expression: BoundExpression,
    alias: string,
    column: string,
): boolean {
    return (
        expression.kind === "BoundColumnReference" &&
        expression.table.alias === alias &&
        expression.column.name === column
    );
}

function isExpectedLiteral(
    expression: BoundExpression,
    expectedValue: string | boolean | null,
): boolean {
    return (
        expression.kind === "BoundLiteral" &&
        normalizePolicyValue(expression.value) === expectedValue
    );
}

function normalizePolicyValue(value: unknown): string | boolean | null {
    if (typeof value === "number") {
        return String(value);
    }

    if (typeof value === "string" || typeof value === "boolean" || value === null) {
        return value;
    }

    throw new Error(`Unsupported policy value: ${String(value)}.`);
}
