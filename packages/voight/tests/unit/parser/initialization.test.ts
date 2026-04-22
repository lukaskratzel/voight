import { afterEach, describe, expect, test, vi } from "vitest";

import { CompilerStage, DiagnosticCode, DiagnosticVisibility } from "../../../src/core/diagnostics";

describe("parser initialization", () => {
    afterEach(() => {
        vi.resetModules();
        vi.doUnmock("../../../src/parser/voight_parser_wasm.js");
    });

    test("surfaces native parser loader failures as internal parser diagnostics", async () => {
        vi.doMock("../../../src/parser/voight_parser_wasm.js", () => ({
            default: async () => {
                throw new Error("mock parser bundle missing");
            },
        }));

        const { parse } = await import("../../../src/parser");
        const result = parse("SELECT 1");

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.stage).toBe(CompilerStage.Parser);
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnsupportedConstruct);
            expect(result.diagnostics[0]?.visibility).toBe(DiagnosticVisibility.Internal);
            expect(result.diagnostics[0]?.message).toContain("mock parser bundle missing");
        }
    });
});
