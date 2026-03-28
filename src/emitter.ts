import type {
    BinaryExpressionNode,
    BoundExpression,
    BoundSelectStatement,
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

export function emit(
    statement: BoundSelectStatement | SelectStatementAst,
    _options: EmitOptions = {},
): EmitResult {
    try {
        const parameterIndices: number[] = [];
        const sql =
            statement.kind === "BoundSelectStatement"
                ? emitBoundSelect(statement, parameterIndices)
                : emitAstSelect(statement, parameterIndices);

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

function emitBoundSelect(statement: BoundSelectStatement, parameterIndices: number[]): string {
    const select = statement.selectItems
        .map((item) => {
            if (item.kind === "BoundSelectWildcardItem") {
                return item.table ? `${item.table.alias}.*` : "*";
            }

            return item.alias
                ? `${emitBoundExpression(item.expression, parameterIndices)} AS ${quoteIdentifier(item.alias)}`
                : emitBoundExpression(item.expression, parameterIndices);
        })
        .join(", ");

    const from = statement.from ? ` FROM ${emitTable(statement.from.ast, parameterIndices)}` : "";
    const joins = statement.joins
        .map(
            (join) =>
                `${join.joinType} JOIN ${emitTable(join.table.ast, parameterIndices)} ON ${emitBoundExpression(join.on, parameterIndices)}`,
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

    const from = statement.from ? ` FROM ${emitTable(statement.from, parameterIndices)}` : "";
    const joins = statement.joins
        .map(
            (join) =>
                `${join.joinType} JOIN ${emitTable(join.table, parameterIndices)} ON ${emitAstExpression(join.on, parameterIndices)}`,
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

function emitTable(
    table: SelectStatementAst["from"],
    parameterIndices: number[],
): string {
    if (!table) {
        throw new Error("Cannot emit a missing table reference.");
    }

    if (table.kind === "DerivedTableReference") {
        return `(${emitAstSelect(table.subquery, parameterIndices)}) AS ${quoteIdentifier(table.alias.name)}`;
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
                emitBoundExpression(expression.left, parameterIndices),
                expression.operator,
                emitBoundExpression(expression.right, parameterIndices),
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
    }
}

function emitAstExpression(
    expression: SelectStatementAst["where"] extends infer T ? Exclude<T, undefined> : never,
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
                emitAstExpression(expression.left, parameterIndices),
                expression.operator,
                emitAstExpression(expression.right, parameterIndices),
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

function quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, "``")}\``;
}
