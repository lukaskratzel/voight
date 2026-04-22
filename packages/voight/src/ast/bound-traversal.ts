import type {
    BoundExpression,
    BoundQuery,
    BoundSelectStatement,
    BoundTableReference,
} from "./index";

export interface BoundTreeVisitor {
    query?(query: BoundQuery): void;
    select?(select: BoundSelectStatement): void;
    table?(table: BoundTableReference): void;
    expression?(expression: BoundExpression): void;
}

export function visitBoundQuery(query: BoundQuery, visitor: BoundTreeVisitor): void {
    visitor.query?.(query);
    query.with?.ctes.forEach((cte) => visitBoundQuery(cte.query, visitor));
    visitBoundSelect(query.body, visitor);
}

function visitBoundSelect(select: BoundSelectStatement, visitor: BoundTreeVisitor): void {
    visitor.select?.(select);

    if (select.from) {
        visitBoundTable(select.from, visitor);
    }

    select.joins.forEach((join) => {
        visitBoundTable(join.table, visitor);
        visitBoundExpression(join.on, visitor);
    });

    select.selectItems.forEach((item) => {
        if (item.kind === "BoundSelectExpressionItem") {
            visitBoundExpression(item.expression, visitor);
        }
    });

    select.where && visitBoundExpression(select.where, visitor);
    select.groupBy.forEach((expression) => visitBoundExpression(expression, visitor));
    select.having && visitBoundExpression(select.having, visitor);
    select.orderBy.forEach((item) => visitBoundExpression(item.expression, visitor));

    if (select.limit) {
        visitBoundExpression(select.limit.count, visitor);
        select.limit.offset && visitBoundExpression(select.limit.offset, visitor);
    }
}

function visitBoundTable(table: BoundTableReference, visitor: BoundTreeVisitor): void {
    visitor.table?.(table);

    if (table.subquery) {
        visitBoundQuery(table.subquery, visitor);
    }
}

function visitBoundExpression(expression: BoundExpression, visitor: BoundTreeVisitor): void {
    visitor.expression?.(expression);

    switch (expression.kind) {
        case "BoundLiteral":
        case "BoundParameter":
        case "BoundColumnReference":
        case "BoundWildcardExpression":
        case "BoundCurrentKeywordExpression":
            return;
        case "BoundGroupingExpression":
            visitBoundExpression(expression.expression, visitor);
            return;
        case "BoundIsNullExpression":
            visitBoundExpression(expression.operand, visitor);
            return;
        case "BoundInListExpression":
            visitBoundExpression(expression.operand, visitor);
            expression.values.forEach((value) => visitBoundExpression(value, visitor));
            return;
        case "BoundBetweenExpression":
            visitBoundExpression(expression.operand, visitor);
            visitBoundExpression(expression.lower, visitor);
            visitBoundExpression(expression.upper, visitor);
            return;
        case "BoundInSubqueryExpression":
            visitBoundExpression(expression.operand, visitor);
            visitBoundQuery(expression.query, visitor);
            return;
        case "BoundExistsExpression":
        case "BoundScalarSubqueryExpression":
            visitBoundQuery(expression.query, visitor);
            return;
        case "BoundUnaryExpression":
            visitBoundExpression(expression.operand, visitor);
            return;
        case "BoundBinaryExpression":
            visitBoundExpression(expression.left, visitor);
            visitBoundExpression(expression.right, visitor);
            return;
        case "BoundFunctionCall":
            expression.arguments.forEach((arg) => visitBoundExpression(arg, visitor));
            if (expression.over) {
                expression.over.partitionBy.forEach((value) =>
                    visitBoundExpression(value, visitor),
                );
                expression.over.orderBy.forEach((item) =>
                    visitBoundExpression(item.expression, visitor),
                );
            }
            return;
        case "BoundCastExpression":
            visitBoundExpression(expression.expression, visitor);
            return;
        case "BoundCaseExpression":
            if (expression.operand) {
                visitBoundExpression(expression.operand, visitor);
            }
            expression.whenClauses.forEach((clause) => {
                visitBoundExpression(clause.when, visitor);
                visitBoundExpression(clause.then, visitor);
            });
            if (expression.elseExpression) {
                visitBoundExpression(expression.elseExpression, visitor);
            }
            return;
        case "BoundIntervalExpression":
            visitBoundExpression(expression.value, visitor);
            return;
    }
}
