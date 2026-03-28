import { describe, expect, test } from "vitest";

import { DiagnosticCode } from "../src/diagnostics";
import { tokenize } from "../src/lexer";

describe("tokenize", () => {
    test("tokenizes a basic select query", () => {
        const result = tokenize("SELECT id, `name` FROM users WHERE tenant_id = ?");

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.tokens.map((token) => token.kind)).toEqual([
            "keyword",
            "identifier",
            "comma",
            "identifier",
            "keyword",
            "identifier",
            "keyword",
            "identifier",
            "operator",
            "parameter",
            "eof",
        ]);
    });

    test("fails on unsupported comments", () => {
        const result = tokenize("SELECT 1 -- comment");

        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnsupportedComment);
    });

    test("fails on unterminated strings", () => {
        const result = tokenize("SELECT 'oops");

        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnterminatedString);
    });

    test("fails on unterminated quoted identifiers", () => {
        const result = tokenize("SELECT `users FROM users");

        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnterminatedQuotedIdentifier);
    });

    test("fails on unexpected characters", () => {
        const result = tokenize("SELECT id FROM users @");

        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnexpectedCharacter);
    });
});
