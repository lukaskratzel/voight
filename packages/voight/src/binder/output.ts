import type {
    BoundColumnReference,
    BoundExpression,
    BoundOutputColumn,
    BoundQuery,
    BoundSelectExpressionItem,
    BoundTableReference,
    CommonTableExpressionNode,
} from "../ast";
import { normalizeIdentifier, type ColumnSchema, type TableSchema } from "../catalog";

export function expandWildcardColumns(
    table: BoundTableReference | undefined,
    visibleTables: readonly BoundTableReference[],
): readonly BoundOutputColumn[] {
    const tables = table ? [table] : visibleTables;
    const columns: BoundOutputColumn[] = [];

    for (const source of tables) {
        for (const column of source.table.columns.values()) {
            if (column.selectable === false) {
                continue;
            }
            columns.push({
                name: column.name,
                column,
                sourceTable: source,
            });
        }
    }

    return columns;
}

export function deriveOutputColumn(
    item: BoundSelectExpressionItem,
    index: number,
): BoundOutputColumn | null {
    if (item.alias) {
        return {
            name: item.alias,
            column: {
                id: `expr:${item.alias}:${index}`,
                name: item.alias,
            },
        };
    }

    if (item.expression.kind === "BoundColumnReference") {
        return {
            name: item.expression.column.name,
            column: item.expression.column,
            sourceTable: item.expression.table,
        };
    }

    return null;
}

export function createQueryTableSchema(
    alias: string,
    query: BoundQuery,
    explicitColumns: CommonTableExpressionNode["columns"] = [],
): TableSchema {
    const columns = new Map<string, ColumnSchema>();
    const names =
        explicitColumns.length > 0
            ? explicitColumns.map((column) => normalizeIdentifier(column.name))
            : query.output.map((column) => column.name);

    names.forEach((name, index) => {
        const source = query.output[index];
        columns.set(name, {
            id: source?.column.id ?? `${alias}.${name}`,
            name,
        });
    });

    return {
        id: `derived:${alias}`,
        name: alias,
        path: {
            parts: [alias],
        },
        columns,
    };
}

export function findNonSelectableProjectionReference(
    expression: BoundExpression,
): BoundColumnReference | undefined {
    switch (expression.kind) {
        case "BoundColumnReference":
            return expression.column.selectable === false ? expression : undefined;
        case "BoundGroupingExpression":
            return findNonSelectableProjectionReference(expression.expression);
        case "BoundIsNullExpression":
            return findNonSelectableProjectionReference(expression.operand);
        case "BoundUnaryExpression":
            return findNonSelectableProjectionReference(expression.operand);
        case "BoundBinaryExpression":
            return (
                findNonSelectableProjectionReference(expression.left) ??
                findNonSelectableProjectionReference(expression.right)
            );
        case "BoundFunctionCall":
            for (const argument of expression.arguments) {
                const match = findNonSelectableProjectionReference(argument);
                if (match) {
                    return match;
                }
            }
            if (expression.over) {
                for (const value of expression.over.partitionBy) {
                    const match = findNonSelectableProjectionReference(value);
                    if (match) {
                        return match;
                    }
                }
                for (const item of expression.over.orderBy) {
                    const match = findNonSelectableProjectionReference(item.expression);
                    if (match) {
                        return match;
                    }
                }
            }
            return undefined;
        case "BoundCastExpression":
            return findNonSelectableProjectionReference(expression.expression);
        case "BoundCaseExpression":
            return (
                (expression.operand
                    ? findNonSelectableProjectionReference(expression.operand)
                    : undefined) ??
                expression.whenClauses
                    .flatMap((clause) => [
                        findNonSelectableProjectionReference(clause.when),
                        findNonSelectableProjectionReference(clause.then),
                    ])
                    .find((value) => typeof value !== "undefined") ??
                (expression.elseExpression
                    ? findNonSelectableProjectionReference(expression.elseExpression)
                    : undefined)
            );
        case "BoundIntervalExpression":
            return findNonSelectableProjectionReference(expression.value);
        case "BoundInListExpression":
            return (
                findNonSelectableProjectionReference(expression.operand) ??
                expression.values
                    .map((value) => findNonSelectableProjectionReference(value))
                    .find((value) => typeof value !== "undefined")
            );
        case "BoundBetweenExpression":
            return (
                findNonSelectableProjectionReference(expression.operand) ??
                findNonSelectableProjectionReference(expression.lower) ??
                findNonSelectableProjectionReference(expression.upper)
            );
        case "BoundInSubqueryExpression":
            return findNonSelectableProjectionReference(expression.operand);
        case "BoundLiteral":
        case "BoundParameter":
        case "BoundWildcardExpression":
        case "BoundCurrentKeywordExpression":
        case "BoundExistsExpression":
        case "BoundScalarSubqueryExpression":
            return undefined;
    }
}
