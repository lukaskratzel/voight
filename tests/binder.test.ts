import { describe, expect, test } from "vitest";

import { bind } from "../src/binder";
import { DiagnosticCode } from "../src/diagnostics";
import { tokenize } from "../src/lexer";
import { parse } from "../src/parser";
import { createTestCatalog } from "../src/testing";

function parseQuery(sql: string) {
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
        const ast = parseQuery(
            "SELECT u.id, o.total FROM users u INNER JOIN orders o ON u.id = o.user_id WHERE u.tenant_id = ?",
        );

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.body.scope.tables.size).toBe(2);
        expect(result.value.body.selectItems[0]?.kind).toBe("BoundSelectExpressionItem");
    });

    test("binds CTEs and correlated subqueries", () => {
        const ast = parseQuery(
            "WITH recent_orders AS (SELECT user_id FROM orders) SELECT id FROM users WHERE EXISTS (SELECT 1 FROM recent_orders r WHERE r.user_id = users.id)",
        );

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.with?.ctes).toHaveLength(1);
        expect(result.value.body.where?.kind).toBe("BoundExistsExpression");
    });

    test("fails for unknown tables", () => {
        const ast = parseQuery("SELECT id FROM missing");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownTable);
    });

    test("fails for ambiguous columns", () => {
        const ast = parseQuery("SELECT id FROM users u INNER JOIN orders o ON u.id = o.user_id");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.AmbiguousColumn);
    });

    test("fails for duplicate table aliases", () => {
        const ast = parseQuery("SELECT u.id FROM users u INNER JOIN orders u ON u.id = u.user_id");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.DuplicateAlias);
    });

    test("fails for unknown qualified columns", () => {
        const ast = parseQuery("SELECT u.missing FROM users u");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownColumn);
    });

    test("fails for unknown aliases in qualified wildcard", () => {
        const ast = parseQuery("SELECT x.* FROM users u");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownTable);
    });

    test("binds unqualified wildcard across known tables", () => {
        const ast = parseQuery("SELECT * FROM users u");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.body.selectItems[0]?.kind).toBe("BoundSelectWildcardItem");
        if (result.value.body.selectItems[0]?.kind === "BoundSelectWildcardItem") {
            expect(result.value.body.selectItems[0].columns.length).toBeGreaterThan(0);
        }
    });
});
