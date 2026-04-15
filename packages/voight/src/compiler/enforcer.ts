import type { BoundQuery } from "../ast";
import { CompilerStage, type Diagnostic } from "../core/diagnostics";
import { type CompilerPolicy, type PolicyContext, resolvePolicies } from "../policies";
import { stageFailure, stageSuccess, type StageResult } from "../core/result";

export interface EnforcementOptions {
    readonly policies?: readonly CompilerPolicy[];
    readonly policyContext?: PolicyContext;
}

export type EnforcementResult = StageResult<
    BoundQuery,
    CompilerStage.Enforcer,
    { policyCount: number }
>;

export function enforce(bound: BoundQuery, options: EnforcementOptions = {}): EnforcementResult {
    const diagnostics: Diagnostic[] = [];
    const policies = resolvePolicies(options);
    const context = {
        context: options.policyContext ?? {},
    };

    policies.forEach((policy) => {
        if (!policy.enforce) {
            return;
        }

        diagnostics.push(...policy.enforce(bound, context));
    });

    if (diagnostics.length > 0) {
        return stageFailure(CompilerStage.Enforcer, diagnostics, { policyCount: policies.length });
    }

    return stageSuccess(CompilerStage.Enforcer, bound, { policyCount: policies.length });
}
