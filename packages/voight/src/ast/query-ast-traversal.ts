import type {
    ExpressionNode,
    QueryAst,
    SelectExpressionItemNode,
    SelectStatementAst,
    TableReferenceNode,
} from "./index";

export function mapQueryAst(
    query: QueryAst,
    rewriteSelect: (select: SelectStatementAst) => SelectStatementAst,
): QueryAst {
    const withClause = query.with
        ? {
              ...query.with,
              ctes: query.with.ctes.map((cte) => ({
                  ...cte,
                  query: mapQueryAst(cte.query, rewriteSelect),
              })),
          }
        : undefined;

    return {
        ...query,
        with: withClause,
        body: rewriteSelect(mapSelectAst(query.body, rewriteSelect)),
    };
}

function mapSelectAst(
    select: SelectStatementAst,
    rewriteSelect: (select: SelectStatementAst) => SelectStatementAst,
): SelectStatementAst {
    const selectItems = select.selectItems.map((item) =>
        item.kind === "SelectExpressionItem" ? mapSelectExpressionItem(item, rewriteSelect) : item,
    );

    return {
        ...select,
        selectItems,
        from: select.from ? mapTableAst(select.from, rewriteSelect) : undefined,
        joins: select.joins.map((join) => ({
            ...join,
            table: mapTableAst(join.table, rewriteSelect),
            on: mapExpressionAst(join.on, rewriteSelect),
        })),
        where: select.where ? mapExpressionAst(select.where, rewriteSelect) : undefined,
        groupBy: select.groupBy.map((expression) => mapExpressionAst(expression, rewriteSelect)),
        having: select.having ? mapExpressionAst(select.having, rewriteSelect) : undefined,
        orderBy: select.orderBy.map((item) => ({
            ...item,
            expression: mapExpressionAst(item.expression, rewriteSelect),
        })),
        limit: select.limit
            ? {
                  ...select.limit,
                  count: mapExpressionAst(select.limit.count, rewriteSelect),
                  offset: select.limit.offset
                      ? mapExpressionAst(select.limit.offset, rewriteSelect)
                      : undefined,
              }
            : undefined,
    };
}

function mapSelectExpressionItem(
    item: SelectExpressionItemNode,
    rewriteSelect: (select: SelectStatementAst) => SelectStatementAst,
): SelectExpressionItemNode {
    return {
        ...item,
        expression: mapExpressionAst(item.expression, rewriteSelect),
    };
}

function mapTableAst(
    table: TableReferenceNode,
    rewriteSelect: (select: SelectStatementAst) => SelectStatementAst,
): TableReferenceNode {
    if (table.kind !== "DerivedTableReference") {
        return table;
    }

    return {
        ...table,
        subquery: mapQueryAst(table.subquery, rewriteSelect),
    };
}

function mapExpressionAst(
    expression: ExpressionNode,
    rewriteSelect: (select: SelectStatementAst) => SelectStatementAst,
): ExpressionNode {
    switch (expression.kind) {
        case "InSubqueryExpression":
            return {
                ...expression,
                operand: mapExpressionAst(expression.operand, rewriteSelect),
                query: mapQueryAst(expression.query, rewriteSelect),
            };
        case "ExistsExpression":
            return {
                ...expression,
                query: mapQueryAst(expression.query, rewriteSelect),
            };
        case "ScalarSubqueryExpression":
            return {
                ...expression,
                query: mapQueryAst(expression.query, rewriteSelect),
            };
        case "BinaryExpression":
            return {
                ...expression,
                left: mapExpressionAst(expression.left, rewriteSelect),
                right: mapExpressionAst(expression.right, rewriteSelect),
            };
        case "UnaryExpression":
            return {
                ...expression,
                operand: mapExpressionAst(expression.operand, rewriteSelect),
            };
        case "GroupingExpression":
            return {
                ...expression,
                expression: mapExpressionAst(expression.expression, rewriteSelect),
            };
        case "IsNullExpression":
            return {
                ...expression,
                operand: mapExpressionAst(expression.operand, rewriteSelect),
            };
        case "InListExpression":
            return {
                ...expression,
                operand: mapExpressionAst(expression.operand, rewriteSelect),
                values: expression.values.map((value) => mapExpressionAst(value, rewriteSelect)),
            };
        case "BetweenExpression":
            return {
                ...expression,
                operand: mapExpressionAst(expression.operand, rewriteSelect),
                lower: mapExpressionAst(expression.lower, rewriteSelect),
                upper: mapExpressionAst(expression.upper, rewriteSelect),
            };
        case "FunctionCall":
            return {
                ...expression,
                arguments: expression.arguments.map((arg) => mapExpressionAst(arg, rewriteSelect)),
                over: expression.over
                    ? {
                          ...expression.over,
                          partitionBy: expression.over.partitionBy.map((value) =>
                              mapExpressionAst(value, rewriteSelect),
                          ),
                          orderBy: expression.over.orderBy.map((item) => ({
                              ...item,
                              expression: mapExpressionAst(item.expression, rewriteSelect),
                          })),
                      }
                    : undefined,
            };
        case "CastExpression":
            return {
                ...expression,
                expression: mapExpressionAst(expression.expression, rewriteSelect),
            };
        case "CaseExpression":
            return {
                ...expression,
                operand: expression.operand
                    ? mapExpressionAst(expression.operand, rewriteSelect)
                    : undefined,
                whenClauses: expression.whenClauses.map((clause) => ({
                    ...clause,
                    when: mapExpressionAst(clause.when, rewriteSelect),
                    then: mapExpressionAst(clause.then, rewriteSelect),
                })),
                elseExpression: expression.elseExpression
                    ? mapExpressionAst(expression.elseExpression, rewriteSelect)
                    : undefined,
            };
        case "IntervalExpression":
            return {
                ...expression,
                value: mapExpressionAst(expression.value, rewriteSelect),
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
