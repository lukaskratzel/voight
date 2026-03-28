import { describe, expect, test } from "bun:test";

import { bind } from "../src/binder";
import { DiagnosticCode } from "../src/diagnostics";
import { tokenize } from "../src/lexer";
import { parse } from "../src/parser";
import { createTestCatalog } from "../src/testing";

function parseStatement(sql: string) {
    const tokens = tokenize(sql);
    if (!tokens.ok) {
        throw new Error(`Lex failed: ${tokens.diagnostics[0]?.message}`);
    }

    const parsed = parse(tokens.value);
    if (!parsed.ok) {
        throw new Error(`Parse failed: ${parsed.diagnostics[0]?.message}`);
    }

    return parsed.value;
}

describe("bind", () => {
    test("binds tables and columns against the catalog", () => {
        const ast = parseStatement(
            "SELECT u.id, o.total FROM users u INNER JOIN orders o ON u.id = o.user_id WHERE u.tenant_id = ?",
        );

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.scope.tables.size).toBe(2);
        expect(result.value.selectItems[0]?.kind).toBe("BoundSelectExpressionItem");
    });

    test("fails for unknown tables", () => {
        const ast = parseStatement("SELECT id FROM missing");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownTable);
    });

    test("fails for ambiguous columns", () => {
        const ast = parseStatement(
            "SELECT id FROM users u INNER JOIN orders o ON u.id = o.user_id",
        );

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.AmbiguousColumn);
    });

    test("fails for duplicate table aliases", () => {
        const ast = parseStatement(
            "SELECT u.id FROM users u INNER JOIN orders u ON u.id = u.user_id",
        );

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.DuplicateAlias);
    });

    test("fails for unknown qualified columns", () => {
        const ast = parseStatement("SELECT u.missing FROM users u");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownColumn);
    });

    test("fails for unknown aliases in qualified wildcard", () => {
        const ast = parseStatement("SELECT x.* FROM users u");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownTable);
    });

    test("binds unqualified wildcard across known tables", () => {
        const ast = parseStatement("SELECT * FROM users u");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.selectItems[0]?.kind).toBe("BoundSelectWildcardItem");
    });
});
