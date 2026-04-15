import { describe, expect, test } from "vitest";

import {
    CompilerStage,
    DiagnosticCode,
    createDiagnostic,
    formatDiagnostics,
} from "../../../src/core/diagnostics";
import { createSpan } from "../../../src/core/source";

describe("formatDiagnostics", () => {
    test("renders mysql-style nearby source context for the failing span", () => {
        const message = formatDiagnostics({
            source: "SELECT id FROM missing",
            diagnostics: [
                createDiagnostic({
                    code: DiagnosticCode.UnknownTable,
                    stage: CompilerStage.Binder,
                    message: 'Unknown table "missing".',
                    primarySpan: createSpan(15, 22),
                }),
            ],
        });

        expect(message).toContain('error[binder/unknown-table] Unknown table "missing".');
        expect(message).toContain('near "...FROM missing"');
    });

    test("renders multiple diagnostics in one string", () => {
        const message = formatDiagnostics({
            source: "SELECT unknown FROM missing",
            diagnostics: [
                createDiagnostic({
                    code: DiagnosticCode.UnknownColumn,
                    stage: CompilerStage.Binder,
                    message: 'Unknown column "unknown".',
                    primarySpan: createSpan(7, 14),
                }),
                createDiagnostic({
                    code: DiagnosticCode.UnknownTable,
                    stage: CompilerStage.Binder,
                    message: 'Unknown table "missing".',
                    primarySpan: createSpan(20, 27),
                }),
            ],
        });

        expect(message).toContain('Unknown column "unknown".');
        expect(message).toContain('near "...LECT unknown FROM..."');
        expect(message).toContain('Unknown table "missing".');
        expect(message).toContain('near "...FROM missing"');
    });
});
