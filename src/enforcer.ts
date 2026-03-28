import type { BoundExpression, BoundQuery, BoundSelectStatement } from "./ast";
import { CompilerStage, DiagnosticCode, createDiagnostic } from "./diagnostics";
import type { CompilerPolicy, PolicyContext } from "./policies";
import { stageFailure, stageSuccess, type StageResult } from "./result";
import type { QueryAnalysis } from "./analyzer";

export interface EnforcementOptions {
    readonly allowedFunctions?: ReadonlySet<string>;
    readonly maxLimit?: number;
    readonly policies?: readonly CompilerPolicy[];
    readonly policyContext?: PolicyContext;
}

export type EnforcementResult = StageResult<
    BoundQuery,
    CompilerStage.Enforcer,
    { checkedFunctions: number; queryBlockCount: number; tableReferenceCount: number }
>;

const SUPPORTED_BINARY_OPERATORS = new Set([
    "+",
    "-",
    "*",
    "/",
    "%",
    "=",
    "!=",
    "<",
    "<=",
    ">",
    ">=",
    "AND",
    "OR",
]);

const SUPPORTED_UNARY_OPERATORS = new Set(["-", "NOT"]);

export function enforce(
    bound: BoundQuery,
    analysis: QueryAnalysis,
    options: EnforcementOptions = {},
): EnforcementResult {
    const diagnostics = [];
    const allowedFunctions = options.allowedFunctions;

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
                if (!SUPPORTED_UNARY_OPERATORS.has(expression.operator)) {
                    diagnostics.push(
                        createDiagnostic({
                            code: DiagnosticCode.UnsupportedOperator,
                            stage: CompilerStage.Enforcer,
                            message: `Unary operator "${expression.operator}" is not supported.`,
                            primarySpan: expression.span,
                        }),
                    );
                    return;
                }
                visitExpression(expression.operand);
                return;
            case "BoundBinaryExpression":
                if (!SUPPORTED_BINARY_OPERATORS.has(expression.operator)) {
                    diagnostics.push(
                        createDiagnostic({
                            code: DiagnosticCode.UnsupportedOperator,
                            stage: CompilerStage.Enforcer,
                            message: `Binary operator "${expression.operator}" is not supported.`,
                            primarySpan: expression.span,
                        }),
                    );
                    return;
                }
                visitExpression(expression.left);
                visitExpression(expression.right);
                return;
            case "BoundFunctionCall":
                if (allowedFunctions && !allowedFunctions.has(expression.callee)) {
                    diagnostics.push(
                        createDiagnostic({
                            code: DiagnosticCode.DisallowedFunction,
                            stage: CompilerStage.Enforcer,
                            message: `Function "${expression.callee}" is not allowed.`,
                            primarySpan: expression.ast.callee.span,
                        }),
                    );
                    return;
                }
                expression.arguments.forEach(visitExpression);
                return;
        }
    };

    const visitSelect = (select: BoundSelectStatement): void => {
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

    const limitValue = readNumericLiteral(bound.body.limit?.count);
    if (
        typeof options.maxLimit === "number" &&
        typeof limitValue === "number" &&
        limitValue > options.maxLimit
    ) {
        diagnostics.push(
            createDiagnostic({
                code: DiagnosticCode.LimitExceeded,
                stage: CompilerStage.Enforcer,
                message: `LIMIT ${limitValue} exceeds the configured maximum of ${options.maxLimit}.`,
                primarySpan: bound.body.limit?.count.span ?? bound.span,
            }),
        );
    }

    for (const policy of options.policies ?? []) {
        if (policy.enforce) {
            diagnostics.push(
                ...policy.enforce(bound, {
                    context: options.policyContext ?? {},
                    analysis,
                }),
            );
        }
    }

    if (diagnostics.length > 0) {
        return stageFailure(CompilerStage.Enforcer, diagnostics, {
            checkedFunctions: analysis.functionCallCount,
            queryBlockCount: analysis.queryBlockCount,
            tableReferenceCount: analysis.tableReferenceCount,
        });
    }

    return stageSuccess(CompilerStage.Enforcer, bound, {
        checkedFunctions: analysis.functionCallCount,
        queryBlockCount: analysis.queryBlockCount,
        tableReferenceCount: analysis.tableReferenceCount,
    });
}

function readNumericLiteral(expression: BoundExpression | undefined): number | undefined {
    if (!expression || expression.kind !== "BoundLiteral") {
        return undefined;
    }

    if (expression.literalType !== "integer") {
        return undefined;
    }

    if (typeof expression.value !== "string") {
        return undefined;
    }

    const parsed = BigInt(expression.value);
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    if (parsed > maxSafe) {
        return Number.MAX_SAFE_INTEGER + 1;
    }

    return Number(parsed);
}
