import type {
    BinaryExpressionNode,
    BoundExpression,
    BoundQuery,
    BoundSelectStatement,
    QueryAst,
    SelectStatementAst,
} from "./ast";
import { CompilerStage, DiagnosticCode, createDiagnostic } from "./diagnostics";
import { stageFailure, stageSuccess, type StageResult } from "./result";

export interface EmitOptions {
    readonly canonical?: boolean;
}

export interface EmitValue {
    readonly sql: string;
    readonly parameters: readonly number[];
}

export type EmitResult = StageResult<EmitValue, CompilerStage.Emitter, { parameterCount: number }>;

export function emit(statement: BoundQuery | QueryAst, _options: EmitOptions = {}): EmitResult {
    try {
        const parameterIndices: number[] = [];
        const sql =
            statement.kind === "BoundQuery"
                ? emitBoundQuery(statement, parameterIndices)
                : emitAstQuery(statement, parameterIndices);

        return stageSuccess(
            CompilerStage.Emitter,
            {
                sql,
                parameters: parameterIndices,
            },
            { parameterCount: parameterIndices.length },
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : "Emitter invariant violation.";
        return stageFailure(
            CompilerStage.Emitter,
            [
                createDiagnostic({
                    code: DiagnosticCode.EmitInvariantViolation,
                    stage: CompilerStage.Emitter,
                    message,
                    primarySpan: statement.span,
                }),
            ],
            { parameterCount: 0 },
        );
    }
}

function emitBoundQuery(query: BoundQuery, parameterIndices: number[]): string {
    const withClause =
        query.with && query.with.ctes.length > 0
            ? `WITH ${query.with.ctes.map((cte) => emitBoundCte(cte, parameterIndices)).join(", ")} `
            : "";
    return `${withClause}${emitBoundSelect(query.body, parameterIndices)}`;
}

function emitAstQuery(query: QueryAst, parameterIndices: number[]): string {
    const withClause =
        query.with && query.with.ctes.length > 0
            ? `WITH ${query.with.ctes.map((cte) => emitAstCte(cte, parameterIndices)).join(", ")} `
            : "";
    return `${withClause}${emitAstSelect(query.body, parameterIndices)}`;
}

function emitBoundCte(
    cte: NonNullable<BoundQuery["with"]>["ctes"][number],
    parameterIndices: number[],
): string {
    const columnList =
        cte.ast.columns.length > 0
            ? ` (${cte.ast.columns.map((column) => quoteIdentifier(column.name)).join(", ")})`
            : "";
    return `${quoteIdentifier(cte.name)}${columnList} AS (${emitBoundQuery(cte.query, parameterIndices)})`;
}

function emitAstCte(
    cte: NonNullable<QueryAst["with"]>["ctes"][number],
    parameterIndices: number[],
): string {
    const columnList =
        cte.columns.length > 0
            ? ` (${cte.columns.map((column) => quoteIdentifier(column.name)).join(", ")})`
            : "";
    return `${quoteIdentifier(cte.name.name)}${columnList} AS (${emitAstQuery(cte.query, parameterIndices)})`;
}

function emitBoundSelect(statement: BoundSelectStatement, parameterIndices: number[]): string {
    const select = statement.selectItems
        .map((item) => {
            if (item.kind === "BoundSelectWildcardItem") {
                return item.table ? `${quoteIdentifier(item.table.alias)}.*` : "*";
            }

            return item.alias
                ? `${emitBoundExpression(item.expression, parameterIndices)} AS ${quoteIdentifier(item.alias)}`
                : emitBoundExpression(item.expression, parameterIndices);
        })
        .join(", ");

    const from = statement.from ? ` FROM ${emitBoundTable(statement.from, parameterIndices)}` : "";
    const joins = statement.joins
        .map(
            (join) =>
                `${join.joinType} JOIN ${emitBoundTable(join.table, parameterIndices)} ON ${emitBoundExpression(join.on, parameterIndices)}`,
        )
        .join(" ");
    const where = statement.where
        ? ` WHERE ${emitBoundExpression(statement.where, parameterIndices)}`
        : "";
    const groupBy =
        statement.groupBy.length > 0
            ? ` GROUP BY ${statement.groupBy.map((expr) => emitBoundExpression(expr, parameterIndices)).join(", ")}`
            : "";
    const having = statement.having
        ? ` HAVING ${emitBoundExpression(statement.having, parameterIndices)}`
        : "";
    const orderBy =
        statement.orderBy.length > 0
            ? ` ORDER BY ${statement.orderBy.map((item) => `${emitBoundExpression(item.expression, parameterIndices)} ${item.direction}`).join(", ")}`
            : "";
    const limit = statement.limit ? emitBoundLimit(statement.limit, parameterIndices) : "";

    return `SELECT ${select}${from}${joins ? ` ${joins}` : ""}${where}${groupBy}${having}${orderBy}${limit}`;
}

function emitAstSelect(statement: SelectStatementAst, parameterIndices: number[]): string {
    const select = statement.selectItems
        .map((item) => {
            if (item.kind === "SelectWildcardItem") {
                return item.qualifier ? `${quoteIdentifier(item.qualifier.name)}.*` : "*";
            }

            return item.alias
                ? `${emitAstExpression(item.expression, parameterIndices)} AS ${quoteIdentifier(item.alias.name)}`
                : emitAstExpression(item.expression, parameterIndices);
        })
        .join(", ");

    const from = statement.from ? ` FROM ${emitAstTable(statement.from, parameterIndices)}` : "";
    const joins = statement.joins
        .map(
            (join) =>
                `${join.joinType} JOIN ${emitAstTable(join.table, parameterIndices)} ON ${emitAstExpression(join.on, parameterIndices)}`,
        )
        .join(" ");
    const where = statement.where
        ? ` WHERE ${emitAstExpression(statement.where, parameterIndices)}`
        : "";
    const groupBy =
        statement.groupBy.length > 0
            ? ` GROUP BY ${statement.groupBy.map((expr) => emitAstExpression(expr, parameterIndices)).join(", ")}`
            : "";
    const having = statement.having
        ? ` HAVING ${emitAstExpression(statement.having, parameterIndices)}`
        : "";
    const orderBy =
        statement.orderBy.length > 0
            ? ` ORDER BY ${statement.orderBy.map((item) => `${emitAstExpression(item.expression, parameterIndices)} ${item.direction}`).join(", ")}`
            : "";
    const limit = statement.limit ? emitAstLimit(statement.limit, parameterIndices) : "";

    return `SELECT ${select}${from}${joins ? ` ${joins}` : ""}${where}${groupBy}${having}${orderBy}${limit}`;
}

function emitBoundTable(table: BoundSelectStatement["from"], parameterIndices: number[]): string {
    if (!table) {
        throw new Error("Cannot emit a missing table reference.");
    }

    if (table.source === "derived" && table.subquery) {
        return `(${emitBoundQuery(table.subquery, parameterIndices)}) AS ${quoteIdentifier(table.alias)}`;
    }

    const qualified = table.table.path.parts.map((part) => quoteIdentifier(part)).join(".");
    return table.alias !== table.table.name
        ? `${qualified} AS ${quoteIdentifier(table.alias)}`
        : qualified;
}

function emitAstTable(table: SelectStatementAst["from"], parameterIndices: number[]): string {
    if (!table) {
        throw new Error("Cannot emit a missing table reference.");
    }

    if (table.kind === "DerivedTableReference") {
        return `(${emitAstQuery(table.subquery, parameterIndices)}) AS ${quoteIdentifier(table.alias.name)}`;
    }

    const qualified = table.name.parts.map((part) => quoteIdentifier(part.name)).join(".");
    return table.alias ? `${qualified} AS ${quoteIdentifier(table.alias.name)}` : qualified;
}

function emitBoundLimit(limit: BoundSelectStatement["limit"], parameterIndices: number[]): string {
    if (!limit) {
        return "";
    }

    if (limit.offset) {
        return ` LIMIT ${emitBoundExpression(limit.count, parameterIndices)} OFFSET ${emitBoundExpression(limit.offset, parameterIndices)}`;
    }

    return ` LIMIT ${emitBoundExpression(limit.count, parameterIndices)}`;
}

function emitAstLimit(
    limit: NonNullable<SelectStatementAst["limit"]>,
    parameterIndices: number[],
): string {
    if (limit.offset) {
        return ` LIMIT ${emitAstExpression(limit.count, parameterIndices)} OFFSET ${emitAstExpression(limit.offset, parameterIndices)}`;
    }

    return ` LIMIT ${emitAstExpression(limit.count, parameterIndices)}`;
}

function emitBoundExpression(expression: BoundExpression, parameterIndices: number[]): string {
    switch (expression.kind) {
        case "BoundLiteral":
            return emitLiteral(expression.value, expression.literalType);
        case "BoundParameter":
            parameterIndices.push(expression.index);
            return "?";
        case "BoundColumnReference":
            return `${quoteIdentifier(expression.table.alias)}.${quoteIdentifier(expression.column.name)}`;
        case "BoundUnaryExpression":
            return expression.operator === "NOT"
                ? `NOT ${emitBoundExpression(expression.operand, parameterIndices)}`
                : `-${emitBoundExpression(expression.operand, parameterIndices)}`;
        case "BoundBinaryExpression":
            return emitBinary(
                emitBoundBinaryOperand(expression.left, expression.operator, parameterIndices),
                expression.operator,
                emitBoundBinaryOperand(expression.right, expression.operator, parameterIndices),
            );
        case "BoundFunctionCall":
            return `${quoteIdentifier(expression.callee)}(${expression.arguments.map((arg) => emitBoundExpression(arg, parameterIndices)).join(", ")})`;
        case "BoundGroupingExpression":
            return `(${emitBoundExpression(expression.expression, parameterIndices)})`;
        case "BoundWildcardExpression":
            return expression.table ? `${quoteIdentifier(expression.table.alias)}.*` : "*";
        case "BoundIsNullExpression":
            return `${emitBoundExpression(expression.operand, parameterIndices)} IS ${expression.negated ? "NOT " : ""}NULL`;
        case "BoundCurrentKeywordExpression":
            return expression.keyword;
        case "BoundInListExpression":
            return `${emitBoundExpression(expression.operand, parameterIndices)} ${expression.negated ? "NOT " : ""}IN (${expression.values.map((value) => emitBoundExpression(value, parameterIndices)).join(", ")})`;
        case "BoundInSubqueryExpression":
            return `${emitBoundExpression(expression.operand, parameterIndices)} ${expression.negated ? "NOT " : ""}IN (${emitBoundQuery(expression.query, parameterIndices)})`;
        case "BoundExistsExpression":
            return `${expression.negated ? "NOT " : ""}EXISTS (${emitBoundQuery(expression.query, parameterIndices)})`;
        case "BoundScalarSubqueryExpression":
            return `(${emitBoundQuery(expression.query, parameterIndices)})`;
    }
}

function emitAstExpression(
    expression: NonNullable<SelectStatementAst["where"]>,
    parameterIndices: number[],
): string {
    switch (expression.kind) {
        case "Literal":
            return emitLiteral(expression.value, expression.literalType);
        case "Parameter":
            parameterIndices.push(expression.index);
            return "?";
        case "IdentifierExpression":
            return quoteIdentifier(expression.identifier.name);
        case "QualifiedReference":
            return `${quoteIdentifier(expression.qualifier.name)}.${quoteIdentifier(expression.column.name)}`;
        case "UnaryExpression":
            return expression.operator === "NOT"
                ? `NOT ${emitAstExpression(expression.operand, parameterIndices)}`
                : `-${emitAstExpression(expression.operand, parameterIndices)}`;
        case "BinaryExpression":
            return emitBinary(
                emitAstBinaryOperand(expression.left, expression.operator, parameterIndices),
                expression.operator,
                emitAstBinaryOperand(expression.right, expression.operator, parameterIndices),
            );
        case "FunctionCall":
            return `${quoteIdentifier(expression.callee.name)}(${expression.arguments.map((arg) => emitAstExpression(arg, parameterIndices)).join(", ")})`;
        case "GroupingExpression":
            return `(${emitAstExpression(expression.expression, parameterIndices)})`;
        case "WildcardExpression":
            return expression.qualifier ? `${quoteIdentifier(expression.qualifier.name)}.*` : "*";
        case "IsNullExpression":
            return `${emitAstExpression(expression.operand, parameterIndices)} IS ${expression.negated ? "NOT " : ""}NULL`;
        case "CurrentKeywordExpression":
            return expression.keyword;
        case "InListExpression":
            return `${emitAstExpression(expression.operand, parameterIndices)} ${expression.negated ? "NOT " : ""}IN (${expression.values.map((value) => emitAstExpression(value, parameterIndices)).join(", ")})`;
        case "InSubqueryExpression":
            return `${emitAstExpression(expression.operand, parameterIndices)} ${expression.negated ? "NOT " : ""}IN (${emitAstQuery(expression.query, parameterIndices)})`;
        case "ExistsExpression":
            return `${expression.negated ? "NOT " : ""}EXISTS (${emitAstQuery(expression.query, parameterIndices)})`;
        case "ScalarSubqueryExpression":
            return `(${emitAstQuery(expression.query, parameterIndices)})`;
    }
}

function emitLiteral(
    value: string | boolean | null,
    literalType?: "string" | "integer" | "decimal" | "boolean" | "null",
): string {
    if (literalType === "integer" || literalType === "decimal") {
        return value as string;
    }

    if (typeof value === "string") {
        return `'${value.replace(/'/g, "''")}'`;
    }

    if (typeof value === "boolean") {
        return value ? "TRUE" : "FALSE";
    }

    if (value === null) {
        return "NULL";
    }
    throw new Error("Unsupported literal emission value.");
}

function emitBinary(
    left: string,
    operator: BinaryExpressionNode["operator"],
    right: string,
): string {
    return `${left} ${operator} ${right}`;
}

function emitBoundBinaryOperand(
    expression: BoundExpression,
    parentOperator: BinaryExpressionNode["operator"],
    parameterIndices: number[],
): string {
    const emitted = emitBoundExpression(expression, parameterIndices);
    return expression.kind === "BoundBinaryExpression" &&
        shouldParenthesizeBinary(expression.operator, parentOperator)
        ? `(${emitted})`
        : emitted;
}

function emitAstBinaryOperand(
    expression: NonNullable<SelectStatementAst["where"]>,
    parentOperator: BinaryExpressionNode["operator"],
    parameterIndices: number[],
): string {
    const emitted = emitAstExpression(expression, parameterIndices);
    return expression.kind === "BinaryExpression" &&
        shouldParenthesizeBinary(expression.operator, parentOperator)
        ? `(${emitted})`
        : emitted;
}

function shouldParenthesizeBinary(
    childOperator: BinaryExpressionNode["operator"],
    parentOperator: BinaryExpressionNode["operator"],
): boolean {
    return binaryPrecedence(childOperator) < binaryPrecedence(parentOperator);
}

function binaryPrecedence(operator: BinaryExpressionNode["operator"]): number {
    switch (operator) {
        case "OR":
            return 1;
        case "AND":
            return 2;
        case "=":
        case "!=":
        case "<":
        case "<=":
        case ">":
        case ">=":
            return 3;
        case "+":
        case "-":
            return 4;
        case "*":
        case "/":
        case "%":
            return 5;
    }
}

function quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, "``")}\``;
}
