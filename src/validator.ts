import type { BoundQuery } from "./ast";
import { analyze } from "./analyzer";
import { enforce, type EnforcementOptions } from "./enforcer";
import { CompilerStage, type Diagnostic } from "./diagnostics";
import { stageFailure, stageSuccess, type StageResult } from "./result";

export interface ValidationOptions extends EnforcementOptions {}

export type ValidationResult = StageResult<
    BoundQuery,
    CompilerStage.Validator,
    { checkedFunctions: number }
>;

export function validate(bound: BoundQuery, options: ValidationOptions = {}): ValidationResult {
    const analysis = analyze(bound);
    if (!analysis.ok) {
        return stageFailure(CompilerStage.Validator, mapDiagnostics(analysis.diagnostics), {
            checkedFunctions: 0,
        });
    }

    const enforced = enforce(bound, analysis.value, options);

    if (!enforced.ok) {
        return stageFailure(CompilerStage.Validator, mapDiagnostics(enforced.diagnostics), {
            checkedFunctions: enforced.meta.checkedFunctions,
        });
    }

    return stageSuccess(CompilerStage.Validator, enforced.value, {
        checkedFunctions: enforced.meta.checkedFunctions,
    });
}

function mapDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
    return diagnostics.map((diagnostic) => ({
        ...diagnostic,
        stage: CompilerStage.Validator,
    }));
}
