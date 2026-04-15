import { describe, expect, test } from "vitest";

import { DiagnosticCode } from "../../../src/core/diagnostics";
import { parseNativeParserOutput } from "../../../src/parser/native-adapter";

describe("parseNativeParserOutput", () => {
    test("maps comment rejections to UnsupportedComment and preserves help and span", () => {
        // The adapter is the only place that translates native parser errors into the
        // public diagnostic model, so both code mapping and source locations matter.
        const result = parseNativeParserOutput(
            "SELECT 1 -- comment",
            JSON.stringify({
                error: true,
                type: "UnsupportedConstruct",
                message: "Comments are not supported.",
                help: "Remove comments from the query.",
                span: {
                    start: { offset: 9 },
                    end: { offset: 19 },
                },
            }),
        );

        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnsupportedComment);
        expect(result.diagnostics[0]?.help).toBe("Remove comments from the query.");
        expect(result.diagnostics[0]?.primarySpan).toEqual({ start: 9, end: 19 });
    });

    test("maps EOF syntax failures to UnexpectedEndOfInput", () => {
        const sql = "SELECT id FROM";
        // EOF needs a distinct diagnostic so callers can distinguish truncation from an
        // arbitrary syntax error and present better feedback.
        const result = parseNativeParserOutput(
            sql,
            JSON.stringify({
                error: true,
                type: "SyntaxError",
                message: "mismatched input '<EOF>' expecting identifier",
                start: sql.length,
                end: sql.length,
            }),
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnexpectedEndOfInput);
        }
    });

    test("rejects invalid JSON payloads from the native parser", () => {
        // Native parser failures must fail closed even if the wasm side returns
        // malformed output instead of a valid error object.
        const result = parseNativeParserOutput("SELECT 1", "{");

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnsupportedConstruct);
            expect(result.diagnostics[0]?.message).toBe("Native parser returned invalid JSON.");
        }
    });

    test("rejects unsupported AST shapes returned by the native parser", () => {
        // Schema validation protects the binder from silently accepting partial or
        // drifted AST payloads when the native format evolves.
        const result = parseNativeParserOutput(
            "SELECT 1",
            JSON.stringify({
                kind: "Query",
                body: {},
            }),
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnsupportedConstruct);
            expect(result.diagnostics[0]?.message).toContain("unsupported AST shape");
        }
    });
});
