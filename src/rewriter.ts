import type { QueryAst } from "./ast";
import { CompilerStage, DiagnosticCode, createDiagnostic } from "./diagnostics";
import type { CompilerPolicy, PolicyContext } from "./policies";
import { stageFailure, stageSuccess, type StageResult } from "./result";

export interface QueryRewriter {
    readonly name?: string;
    rewrite(query: QueryAst): QueryAst;
}

export interface RewriteOptions {
    readonly rewriters?: readonly QueryRewriter[];
    readonly policies?: readonly CompilerPolicy[];
    readonly policyContext?: PolicyContext;
}

export type RewriteResult = StageResult<
    QueryAst,
    CompilerStage.Rewriter,
    { appliedRewriters: number; changed: boolean }
>;

export function rewrite(query: QueryAst, options: RewriteOptions = {}): RewriteResult {
    const rewriters = options.rewriters ?? [];
    const policies = options.policies ?? [];
    let rewritten = query;

    try {
        for (const policy of policies) {
            if (policy.rewrite) {
                rewritten = policy.rewrite(rewritten, {
                    context: options.policyContext ?? {},
                });
            }
        }

        for (const rewriter of rewriters) {
            rewritten = rewriter.rewrite(rewritten);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : "Rewrite invariant violation.";
        return stageFailure(
            CompilerStage.Rewriter,
            [
                createDiagnostic({
                    code: DiagnosticCode.RewriteInvariantViolation,
                    stage: CompilerStage.Rewriter,
                    message,
                    primarySpan: query.span,
                }),
            ],
            { appliedRewriters: rewriters.length, changed: false },
        );
    }

    return stageSuccess(CompilerStage.Rewriter, rewritten, {
        appliedRewriters:
            rewriters.length +
            policies.filter((policy) => typeof policy.rewrite === "function").length,
        changed: rewritten !== query,
    });
}
