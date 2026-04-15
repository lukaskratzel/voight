import type { BoundExpression, BoundQuery, BoundSelectStatement } from "./index";
import type { Diagnostic } from "../core/diagnostics";
import { visitBoundQuery } from "./bound-traversal";

export interface BoundPolicyVisitor {
    select?(select: BoundSelectStatement): readonly Diagnostic[] | void;
    expression?(expression: BoundExpression): readonly Diagnostic[] | void;
    finish?(query: BoundQuery): readonly Diagnostic[] | void;
}

export function collectBoundPolicyDiagnostics(
    query: BoundQuery,
    visitor: BoundPolicyVisitor,
): readonly Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    visitBoundQuery(query, {
        select: (select) => {
            diagnostics.push(...(visitor.select?.(select) ?? []));
        },
        expression: (expression) => {
            diagnostics.push(...(visitor.expression?.(expression) ?? []));
        },
    });

    diagnostics.push(...(visitor.finish?.(query) ?? []));

    return diagnostics;
}
