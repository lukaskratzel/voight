import type { QueryAst } from "../ast";
import {
    CompilerStage,
    DiagnosticCode,
    DiagnosticVisibility,
    createDiagnostic,
} from "../core/diagnostics";
import { type CompilerPolicy, type PolicyContext, resolvePolicies } from "../policies";
import { PolicyError } from "../policies/shared";
import type { Catalog } from "../catalog";
import { stageFailure, stageSuccess, type StageResult } from "../core/result";

const JOIN_TYPES = new Set(["INNER", "LEFT"]);
const ORDER_DIRECTIONS = new Set(["ASC", "DESC"]);
const UNARY_OPERATORS = new Set(["-", "NOT"]);
const BINARY_OPERATORS = new Set([
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
    "LIKE",
    "REGEXP",
    "RLIKE",
    "AND",
    "OR",
]);
const CURRENT_KEYWORDS = new Set(["CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME"]);
const INTERVAL_UNITS = new Set([
    "SECOND",
    "MINUTE",
    "HOUR",
    "DAY",
    "WEEK",
    "MONTH",
    "QUARTER",
    "YEAR",
]);
const LITERAL_TYPES = new Set(["string", "integer", "decimal", "boolean", "null"]);
const INTEGER_LITERAL_PATTERN = /^[0-9]+$/;
const DECIMAL_LITERAL_PATTERN = /^[0-9]+\.[0-9]+$/;

export interface QueryRewriter {
    readonly name?: string;
    rewrite(query: QueryAst): QueryAst;
}

export interface RewriteOptions {
    readonly rewriters?: readonly QueryRewriter[];
    readonly policies?: readonly CompilerPolicy[];
    readonly policyContext?: PolicyContext;
    readonly catalog?: Catalog;
}

export type RewriteResult = StageResult<
    QueryAst,
    CompilerStage.Rewriter,
    { appliedRewriters: number; changed: boolean }
>;

export function rewrite(query: QueryAst, options: RewriteOptions = {}): RewriteResult {
    const rewriters = options.rewriters ?? [];
    const policies = resolvePolicies(options);
    let rewritten = query;

    try {
        for (const policy of policies) {
            if (policy.rewrite) {
                rewritten = policy.rewrite(rewritten, {
                    context: options.policyContext ?? {},
                    catalog: options.catalog,
                });
            }
        }

        for (const rewriter of rewriters) {
            rewritten = rewriter.rewrite(rewritten);
        }
    } catch (error) {
        if (error instanceof PolicyError) {
            throw error;
        }
        const message = error instanceof Error ? error.message : "Rewrite invariant violation.";
        return stageFailure(
            CompilerStage.Rewriter,
            [
                createDiagnostic({
                    code: DiagnosticCode.RewriteInvariantViolation,
                    stage: CompilerStage.Rewriter,
                    message,
                    primarySpan: query.span,
                    visibility: DiagnosticVisibility.Internal,
                }),
            ],
            { appliedRewriters: rewriters.length, changed: false },
        );
    }

    const validation = validateRewriteQueryShape(rewritten);
    if (!validation.ok) {
        return stageFailure(
            CompilerStage.Rewriter,
            [
                createDiagnostic({
                    code: DiagnosticCode.RewriteInvariantViolation,
                    stage: CompilerStage.Rewriter,
                    message: `Rewriter produced an invalid AST: ${validation.summary}`,
                    primarySpan: query.span,
                    visibility: DiagnosticVisibility.Internal,
                }),
            ],
            {
                appliedRewriters:
                    rewriters.length +
                    policies.filter((policy) => typeof policy.rewrite === "function").length,
                changed: rewritten !== query,
            },
        );
    }

    return stageSuccess(CompilerStage.Rewriter, rewritten, {
        appliedRewriters:
            rewriters.length +
            policies.filter((policy) => typeof policy.rewrite === "function").length,
        changed: rewritten !== query,
    });
}

function validateRewriteQueryShape(
    query: QueryAst,
): { readonly ok: true } | { readonly ok: false; readonly summary: string } {
    const errors: string[] = [];
    validateQueryNode(query, "query", errors);

    return errors.length === 0
        ? { ok: true }
        : {
              ok: false,
              summary: errors.join("\n"),
          };
}

function validateQueryNode(node: unknown, path: string, errors: string[]): void {
    if (!isRecord(node)) {
        errors.push(`${path} must be an object.`);
        return;
    }

    if (node.kind !== "Query") {
        errors.push(`${path}.kind must be "Query".`);
    }

    validateSpan(node.span, `${path}.span`, errors);
    if (typeof node.with !== "undefined") {
        validateWithClause(node.with, `${path}.with`, errors);
    }
    validateSelectStatement(node.body, `${path}.body`, errors);
}

function validateWithClause(node: unknown, path: string, errors: string[]): void {
    if (!isRecord(node)) {
        errors.push(`${path} must be an object.`);
        return;
    }

    if (node.kind !== "WithClause") {
        errors.push(`${path}.kind must be "WithClause".`);
    }

    validateSpan(node.span, `${path}.span`, errors);
    validateArray(node.ctes, `${path}.ctes`, errors, validateCommonTableExpression);
}

function validateCommonTableExpression(node: unknown, path: string, errors: string[]): void {
    if (!isRecord(node)) {
        errors.push(`${path} must be an object.`);
        return;
    }

    if (node.kind !== "CommonTableExpression") {
        errors.push(`${path}.kind must be "CommonTableExpression".`);
    }

    validateSpan(node.span, `${path}.span`, errors);
    validateIdentifier(node.name, `${path}.name`, errors);
    validateArray(node.columns, `${path}.columns`, errors, validateIdentifier);
    validateQueryNode(node.query, `${path}.query`, errors);
}

function validateSelectStatement(node: unknown, path: string, errors: string[]): void {
    if (!isRecord(node)) {
        errors.push(`${path} must be an object.`);
        return;
    }

    if (node.kind !== "SelectStatement") {
        errors.push(`${path}.kind must be "SelectStatement".`);
    }

    validateSpan(node.span, `${path}.span`, errors);
    if (typeof node.distinct !== "boolean") {
        errors.push(`${path}.distinct must be a boolean.`);
    }
    validateArray(node.selectItems, `${path}.selectItems`, errors, validateSelectItem);
    if (typeof node.from !== "undefined") {
        validateTableReference(node.from, `${path}.from`, errors);
    }
    validateArray(node.joins, `${path}.joins`, errors, validateJoin);
    if (typeof node.where !== "undefined") {
        validateExpression(node.where, `${path}.where`, errors);
    }
    validateArray(node.groupBy, `${path}.groupBy`, errors, validateExpression);
    if (typeof node.having !== "undefined") {
        validateExpression(node.having, `${path}.having`, errors);
    }
    validateArray(node.orderBy, `${path}.orderBy`, errors, validateOrderByItem);
    if (typeof node.limit !== "undefined") {
        validateLimitClause(node.limit, `${path}.limit`, errors);
    }
}

function validateSelectItem(node: unknown, path: string, errors: string[]): void {
    if (!isRecord(node)) {
        errors.push(`${path} must be an object.`);
        return;
    }

    validateSpan(node.span, `${path}.span`, errors);

    if (node.kind === "SelectExpressionItem") {
        validateExpression(node.expression, `${path}.expression`, errors);
        if (typeof node.alias !== "undefined") {
            validateIdentifier(node.alias, `${path}.alias`, errors);
        }
        return;
    }

    if (node.kind === "SelectWildcardItem") {
        if (typeof node.qualifier !== "undefined") {
            validateIdentifier(node.qualifier, `${path}.qualifier`, errors);
        }
        return;
    }

    errors.push(`${path}.kind must be a supported select item.`);
}

function validateTableReference(node: unknown, path: string, errors: string[]): void {
    if (!isRecord(node)) {
        errors.push(`${path} must be an object.`);
        return;
    }

    validateSpan(node.span, `${path}.span`, errors);

    if (node.kind === "TableReference") {
        validateQualifiedName(node.name, `${path}.name`, errors);
        if (typeof node.alias !== "undefined") {
            validateIdentifier(node.alias, `${path}.alias`, errors);
        }
        return;
    }

    if (node.kind === "DerivedTableReference") {
        validateQueryNode(node.subquery, `${path}.subquery`, errors);
        validateIdentifier(node.alias, `${path}.alias`, errors);
        return;
    }

    errors.push(`${path}.kind must be a supported table reference.`);
}

function validateJoin(node: unknown, path: string, errors: string[]): void {
    if (!isRecord(node)) {
        errors.push(`${path} must be an object.`);
        return;
    }

    if (typeof node.joinType !== "string") {
        errors.push(`${path}.joinType must be a string.`);
    } else if (!JOIN_TYPES.has(node.joinType)) {
        errors.push(`${path}.joinType must be "INNER" or "LEFT".`);
    }

    validateSpan(node.span, `${path}.span`, errors);
    validateTableReference(node.table, `${path}.table`, errors);
    validateExpression(node.on, `${path}.on`, errors);
}

function validateOrderByItem(node: unknown, path: string, errors: string[]): void {
    if (!isRecord(node)) {
        errors.push(`${path} must be an object.`);
        return;
    }

    if (typeof node.direction !== "string") {
        errors.push(`${path}.direction must be a string.`);
    } else if (!ORDER_DIRECTIONS.has(node.direction)) {
        errors.push(`${path}.direction must be "ASC" or "DESC".`);
    }

    validateSpan(node.span, `${path}.span`, errors);
    validateExpression(node.expression, `${path}.expression`, errors);
}

function validateLimitClause(node: unknown, path: string, errors: string[]): void {
    if (!isRecord(node)) {
        errors.push(`${path} must be an object.`);
        return;
    }

    if (node.kind !== "LimitClause") {
        errors.push(`${path}.kind must be "LimitClause".`);
    }

    validateSpan(node.span, `${path}.span`, errors);
    validateExpression(node.count, `${path}.count`, errors);
    if (typeof node.offset !== "undefined") {
        validateExpression(node.offset, `${path}.offset`, errors);
    }
}

function validateExpression(node: unknown, path: string, errors: string[]): void {
    if (!isRecord(node)) {
        errors.push(`${path} must be an object.`);
        return;
    }

    validateSpan(node.span, `${path}.span`, errors);

    switch (node.kind) {
        case "IdentifierExpression":
            validateIdentifier(node.identifier, `${path}.identifier`, errors);
            return;
        case "QualifiedReference":
            validateIdentifier(node.qualifier, `${path}.qualifier`, errors);
            validateIdentifier(node.column, `${path}.column`, errors);
            return;
        case "WildcardExpression":
            if (typeof node.qualifier !== "undefined") {
                validateIdentifier(node.qualifier, `${path}.qualifier`, errors);
            }
            return;
        case "Literal":
            validateLiteral(node, path, errors);
            return;
        case "Parameter":
            if (!Number.isInteger(node.index)) {
                errors.push(`${path}.index must be an integer.`);
            }
            return;
        case "UnaryExpression":
            if (typeof node.operator !== "string") {
                errors.push(`${path}.operator must be a string.`);
            } else if (!UNARY_OPERATORS.has(node.operator)) {
                errors.push(`${path}.operator must be a supported unary operator.`);
            }
            validateExpression(node.operand, `${path}.operand`, errors);
            return;
        case "BinaryExpression":
            if (typeof node.operator !== "string") {
                errors.push(`${path}.operator must be a string.`);
            } else if (!BINARY_OPERATORS.has(node.operator)) {
                errors.push(`${path}.operator must be a supported binary operator.`);
            }
            validateExpression(node.left, `${path}.left`, errors);
            validateExpression(node.right, `${path}.right`, errors);
            return;
        case "FunctionCall":
            validateIdentifier(node.callee, `${path}.callee`, errors);
            if (typeof node.distinct !== "boolean") {
                errors.push(`${path}.distinct must be a boolean.`);
            }
            validateArray(node.arguments, `${path}.arguments`, errors, validateExpression);
            if (typeof node.over !== "undefined") {
                validateWindowSpecification(node.over, `${path}.over`, errors);
            }
            return;
        case "CastExpression":
            validateExpression(node.expression, `${path}.expression`, errors);
            validateCastType(node.targetType, `${path}.targetType`, errors);
            return;
        case "CaseExpression":
            if (typeof node.operand !== "undefined") {
                validateExpression(node.operand, `${path}.operand`, errors);
            }
            validateArray(node.whenClauses, `${path}.whenClauses`, errors, validateCaseWhenClause);
            if (typeof node.elseExpression !== "undefined") {
                validateExpression(node.elseExpression, `${path}.elseExpression`, errors);
            }
            return;
        case "IntervalExpression":
            validateExpression(node.value, `${path}.value`, errors);
            if (typeof node.unit !== "string") {
                errors.push(`${path}.unit must be a string.`);
            } else if (!INTERVAL_UNITS.has(node.unit)) {
                errors.push(`${path}.unit must be a supported interval unit.`);
            }
            return;
        case "GroupingExpression":
            validateExpression(node.expression, `${path}.expression`, errors);
            return;
        case "IsNullExpression":
            if (typeof node.negated !== "boolean") {
                errors.push(`${path}.negated must be a boolean.`);
            }
            validateExpression(node.operand, `${path}.operand`, errors);
            return;
        case "CurrentKeywordExpression":
            if (typeof node.keyword !== "string") {
                errors.push(`${path}.keyword must be a string.`);
            } else if (!CURRENT_KEYWORDS.has(node.keyword)) {
                errors.push(`${path}.keyword must be a supported CURRENT_* keyword.`);
            }
            return;
        case "BetweenExpression":
            if (typeof node.negated !== "boolean") {
                errors.push(`${path}.negated must be a boolean.`);
            }
            validateExpression(node.operand, `${path}.operand`, errors);
            validateExpression(node.lower, `${path}.lower`, errors);
            validateExpression(node.upper, `${path}.upper`, errors);
            return;
        case "InListExpression":
            if (typeof node.negated !== "boolean") {
                errors.push(`${path}.negated must be a boolean.`);
            }
            validateExpression(node.operand, `${path}.operand`, errors);
            validateArray(node.values, `${path}.values`, errors, validateExpression);
            return;
        case "InSubqueryExpression":
            if (typeof node.negated !== "boolean") {
                errors.push(`${path}.negated must be a boolean.`);
            }
            validateExpression(node.operand, `${path}.operand`, errors);
            validateQueryNode(node.query, `${path}.query`, errors);
            return;
        case "ExistsExpression":
            if (typeof node.negated !== "boolean") {
                errors.push(`${path}.negated must be a boolean.`);
            }
            validateQueryNode(node.query, `${path}.query`, errors);
            return;
        case "ScalarSubqueryExpression":
            validateQueryNode(node.query, `${path}.query`, errors);
            return;
        default:
            errors.push(`${path}.kind must be a supported expression node.`);
    }
}

function validateCaseWhenClause(node: unknown, path: string, errors: string[]): void {
    if (!isRecord(node)) {
        errors.push(`${path} must be an object.`);
        return;
    }

    if (node.kind !== "CaseWhenClause") {
        errors.push(`${path}.kind must be "CaseWhenClause".`);
    }

    validateSpan(node.span, `${path}.span`, errors);
    validateExpression(node.when, `${path}.when`, errors);
    validateExpression(node.then, `${path}.then`, errors);
}

function validateWindowSpecification(node: unknown, path: string, errors: string[]): void {
    if (!isRecord(node)) {
        errors.push(`${path} must be an object.`);
        return;
    }

    if (node.kind !== "WindowSpecification") {
        errors.push(`${path}.kind must be "WindowSpecification".`);
    }

    validateSpan(node.span, `${path}.span`, errors);
    validateArray(node.partitionBy, `${path}.partitionBy`, errors, validateExpression);
    validateArray(node.orderBy, `${path}.orderBy`, errors, validateOrderByItem);
}

function validateCastType(node: unknown, path: string, errors: string[]): void {
    if (!isRecord(node)) {
        errors.push(`${path} must be an object.`);
        return;
    }

    if (node.kind !== "CastType") {
        errors.push(`${path}.kind must be "CastType".`);
    }

    validateSpan(node.span, `${path}.span`, errors);
    validateQualifiedName(node.name, `${path}.name`, errors);
    validateArray(node.arguments, `${path}.arguments`, errors, validateCastTypeArgument);
}

function validateCastTypeArgument(node: unknown, path: string, errors: string[]): void {
    if (!isRecord(node)) {
        errors.push(`${path} must be an object.`);
        return;
    }

    if (node.kind === "CastType") {
        validateCastType(node, path, errors);
        return;
    }

    if (node.kind === "Literal") {
        validateLiteral(node, path, errors);
        if (node.literalType !== "integer") {
            errors.push(`${path} must be an integer literal or nested cast type.`);
        }
        return;
    }

    errors.push(`${path}.kind must be "CastType" or an integer literal.`);
}

function validateQualifiedName(node: unknown, path: string, errors: string[]): void {
    if (!isRecord(node)) {
        errors.push(`${path} must be an object.`);
        return;
    }

    if (node.kind !== "QualifiedName") {
        errors.push(`${path}.kind must be "QualifiedName".`);
    }

    validateSpan(node.span, `${path}.span`, errors);
    validateArray(node.parts, `${path}.parts`, errors, validateIdentifier);
}

function validateIdentifier(node: unknown, path: string, errors: string[]): void {
    if (!isRecord(node)) {
        errors.push(`${path} must be an object.`);
        return;
    }

    if (node.kind !== "Identifier") {
        errors.push(`${path}.kind must be "Identifier".`);
    }

    if (typeof node.name !== "string") {
        errors.push(`${path}.name must be a string.`);
    }

    if (typeof node.quoted !== "boolean") {
        errors.push(`${path}.quoted must be a boolean.`);
    }

    validateSpan(node.span, `${path}.span`, errors);
}

function validateSpan(node: unknown, path: string, errors: string[]): void {
    if (!isRecord(node)) {
        errors.push(`${path} must be an object.`);
        return;
    }

    if (!Number.isInteger(node.start)) {
        errors.push(`${path}.start must be an integer.`);
    }

    if (!Number.isInteger(node.end)) {
        errors.push(`${path}.end must be an integer.`);
    }

    const start = node.start;
    const end = node.end;
    if (
        typeof start === "number" &&
        typeof end === "number" &&
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        (start < 0 || end < start)
    ) {
        errors.push(`${path} must have 0 <= start <= end.`);
    }
}

function validateLiteral(node: Record<string, unknown>, path: string, errors: string[]): void {
    if (typeof node.literalType !== "string") {
        errors.push(`${path}.literalType must be a string.`);
        return;
    }

    if (!LITERAL_TYPES.has(node.literalType)) {
        errors.push(`${path}.literalType must be a supported literal type.`);
        return;
    }

    switch (node.literalType) {
        case "string":
            if (typeof node.value !== "string") {
                errors.push(`${path}.value must be a string for string literals.`);
            }
            return;
        case "integer":
            if (typeof node.value !== "string" || !INTEGER_LITERAL_PATTERN.test(node.value)) {
                errors.push(`${path}.value must be an unsigned integer literal string.`);
            }
            return;
        case "decimal":
            if (typeof node.value !== "string" || !DECIMAL_LITERAL_PATTERN.test(node.value)) {
                errors.push(`${path}.value must be a decimal literal string.`);
            }
            return;
        case "boolean":
            if (typeof node.value !== "boolean") {
                errors.push(`${path}.value must be a boolean for boolean literals.`);
            }
            return;
        case "null":
            if (node.value !== null) {
                errors.push(`${path}.value must be null for null literals.`);
            }
            return;
    }
}

function validateArray(
    value: unknown,
    path: string,
    errors: string[],
    validateItem: (item: unknown, itemPath: string, errors: string[]) => void,
): void {
    if (!Array.isArray(value)) {
        errors.push(`${path} must be an array.`);
        return;
    }

    value.forEach((item, index) => {
        validateItem(item, `${path}[${index}]`, errors);
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
