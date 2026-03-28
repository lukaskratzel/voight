import type { BoundExpression, BoundSelectStatement } from "./ast";
import { CompilerStage, DiagnosticCode, createDiagnostic } from "./diagnostics";
import { stageFailure, stageSuccess, type StageResult } from "./result";

export interface ValidationOptions {
    readonly allowedFunctions?: ReadonlySet<string>;
    readonly maxLimit?: number;
}

export type ValidationResult = StageResult<
    BoundSelectStatement,
    CompilerStage.Validator,
    { checkedFunctions: number }
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

export function validate(
    bound: BoundSelectStatement,
    options: ValidationOptions = {},
): ValidationResult {
    const diagnostics = [];
    let checkedFunctions = 0;
    const allowedFunctions = options.allowedFunctions;

    const visit = (expression: BoundExpression): void => {
        switch (expression.kind) {
      case "BoundLiteral":
      case "BoundParameter":
      case "BoundColumnReference":
      case "BoundWildcardExpression":
      case "BoundCurrentKeywordExpression":
        return;
            case "BoundGroupingExpression":
                visit(expression.expression);
                return;
            case "BoundIsNullExpression":
                visit(expression.operand);
                return;
            case "BoundInListExpression":
                visit(expression.operand);
                expression.values.forEach(visit);
                return;
            case "BoundUnaryExpression":
                if (!SUPPORTED_UNARY_OPERATORS.has(expression.operator)) {
                    diagnostics.push(
                        createDiagnostic({
                            code: DiagnosticCode.UnsupportedOperator,
                            stage: CompilerStage.Validator,
                            message: `Unary operator "${expression.operator}" is not supported.`,
                            primarySpan: expression.span,
                        }),
                    );
                    return;
                }
                visit(expression.operand);
                return;
            case "BoundBinaryExpression":
                if (!SUPPORTED_BINARY_OPERATORS.has(expression.operator)) {
                    diagnostics.push(
                        createDiagnostic({
                            code: DiagnosticCode.UnsupportedOperator,
                            stage: CompilerStage.Validator,
                            message: `Binary operator "${expression.operator}" is not supported.`,
                            primarySpan: expression.span,
                        }),
                    );
                    return;
                }
                visit(expression.left);
                visit(expression.right);
                return;
            case "BoundFunctionCall":
                checkedFunctions += 1;
                if (allowedFunctions && !allowedFunctions.has(expression.callee)) {
                    diagnostics.push(
                        createDiagnostic({
                            code: DiagnosticCode.DisallowedFunction,
                            stage: CompilerStage.Validator,
                            message: `Function "${expression.callee}" is not allowed.`,
                            primarySpan: expression.ast.callee.span,
                        }),
                    );
                    return;
                }
                expression.arguments.forEach(visit);
                return;
        }
    };

    bound.selectItems.forEach((item) => {
        if (item.kind === "BoundSelectExpressionItem") {
            visit(item.expression);
        }
    });
    bound.where && visit(bound.where);
    bound.groupBy.forEach(visit);
    bound.having && visit(bound.having);
    bound.orderBy.forEach((item) => visit(item.expression));
    bound.joins.forEach((join) => visit(join.on));
    if (bound.limit) {
        visit(bound.limit.count);
        bound.limit.offset && visit(bound.limit.offset);
    }

    const limitValue = readNumericLiteral(bound.limit?.count);
    if (
        typeof options.maxLimit === "number" &&
        typeof limitValue === "number" &&
        limitValue > options.maxLimit
    ) {
        diagnostics.push(
            createDiagnostic({
                code: DiagnosticCode.LimitExceeded,
                stage: CompilerStage.Validator,
                message: `LIMIT ${limitValue} exceeds the configured maximum of ${options.maxLimit}.`,
                primarySpan: bound.limit?.count.span ?? bound.span,
            }),
        );
    }

    if (diagnostics.length > 0) {
        return stageFailure(CompilerStage.Validator, diagnostics, {
            checkedFunctions,
        });
    }

    return stageSuccess(CompilerStage.Validator, bound, {
        checkedFunctions,
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
