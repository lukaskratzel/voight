import { compile, type CompileOptions, type CompileResult } from "../../src/compiler";
import { allowedFunctionsPolicy, maxLimitPolicy, type CompilerPolicy } from "../../src/policies";
import { createTestCatalog } from "../../src/testing";

export type StrictCompileOptions = Partial<CompileOptions> & {
    allowedFunctions?: ReadonlySet<string>;
    maxLimit?: number;
    maxOffset?: number;
    defaultLimit?: number;
};

export const testCatalog = createTestCatalog();
export const DEFAULT_ALLOWED_FUNCTIONS = new Set([
    "count",
    "sum",
    "avg",
    "min",
    "max",
    "coalesce",
    "nullif",
    "round",
]);

export function compileStrict(sql: string, extra: StrictCompileOptions = {}): CompileResult {
    const policies: CompilerPolicy[] = [...(extra.policies ?? [])];
    if (extra.allowedFunctions) {
        policies.push(allowedFunctionsPolicy({ allowedFunctions: extra.allowedFunctions }));
    }
    if (typeof extra.maxLimit === "number") {
        policies.push(
            maxLimitPolicy({
                maxLimit: extra.maxLimit,
                maxOffset: extra.maxOffset,
                defaultLimit: extra.defaultLimit,
            }),
        );
    }

    return compile(sql, {
        catalog: extra.catalog ?? testCatalog,
        policies,
        policyContext: extra.policyContext,
        rewriters: extra.rewriters,
        debug: extra.debug ?? true,
    });
}

export function compileWithAllowedFunctions(
    sql: string,
    allowedFunctions: ReadonlySet<string> = DEFAULT_ALLOWED_FUNCTIONS,
    extra: Omit<StrictCompileOptions, "allowedFunctions"> = {},
): CompileResult {
    return compileStrict(sql, {
        ...extra,
        allowedFunctions: new Set(allowedFunctions),
    });
}
