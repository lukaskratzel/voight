import type { BoundExpression, BoundQuery, BoundSelectStatement } from "./ast";
import { CompilerStage } from "./diagnostics";
import { stageSuccess, type StageResult } from "./result";

export interface QueryAnalysis {
    readonly functionCallCount: number;
    readonly queryBlockCount: number;
    readonly tableReferenceCount: number;
    readonly maxGroupByCount: number;
}

export type AnalysisResult = StageResult<QueryAnalysis, CompilerStage.Analyzer, QueryAnalysis>;

export function analyze(bound: BoundQuery): AnalysisResult {
    let functionCallCount = 0;
    let queryBlockCount = 0;
    let tableReferenceCount = 0;
    let maxGroupByCount = 0;

    const visitExpression = (expression: BoundExpression): void => {
        switch (expression.kind) {
            case "BoundLiteral":
            case "BoundParameter":
            case "BoundColumnReference":
            case "BoundWildcardExpression":
            case "BoundCurrentKeywordExpression":
                return;
            case "BoundGroupingExpression":
                visitExpression(expression.expression);
                return;
            case "BoundIsNullExpression":
                visitExpression(expression.operand);
                return;
            case "BoundInListExpression":
                visitExpression(expression.operand);
                expression.values.forEach(visitExpression);
                return;
            case "BoundInSubqueryExpression":
                visitExpression(expression.operand);
                visitQuery(expression.query);
                return;
            case "BoundExistsExpression":
                visitQuery(expression.query);
                return;
            case "BoundScalarSubqueryExpression":
                visitQuery(expression.query);
                return;
            case "BoundUnaryExpression":
                visitExpression(expression.operand);
                return;
            case "BoundBinaryExpression":
                visitExpression(expression.left);
                visitExpression(expression.right);
                return;
            case "BoundFunctionCall":
                functionCallCount += 1;
                expression.arguments.forEach(visitExpression);
                return;
        }
    };

    const visitSelect = (select: BoundSelectStatement): void => {
        queryBlockCount += 1;
        tableReferenceCount += select.scope.tables.size;
        maxGroupByCount = Math.max(maxGroupByCount, select.groupBy.length);

        select.selectItems.forEach((item) => {
            if (item.kind === "BoundSelectExpressionItem") {
                visitExpression(item.expression);
            }
        });
        select.where && visitExpression(select.where);
        select.groupBy.forEach(visitExpression);
        select.having && visitExpression(select.having);
        select.orderBy.forEach((item) => visitExpression(item.expression));
        select.joins.forEach((join) => visitExpression(join.on));
        if (select.limit) {
            visitExpression(select.limit.count);
            select.limit.offset && visitExpression(select.limit.offset);
        }
    };

    const visitQuery = (query: BoundQuery): void => {
        query.with?.ctes.forEach((cte) => visitQuery(cte.query));
        visitSelect(query.body);
    };

    visitQuery(bound);

    const analysis: QueryAnalysis = {
        functionCallCount,
        queryBlockCount,
        tableReferenceCount,
        maxGroupByCount,
    };

    return stageSuccess(CompilerStage.Analyzer, analysis, analysis);
}
