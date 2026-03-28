import { describe, expect, test } from "bun:test";

import { DiagnosticCode } from "../src/diagnostics";
import { tokenize } from "../src/lexer";
import { parse } from "../src/parser";

describe("parse", () => {
    test("parses select with join, grouping, ordering, and limit", () => {
        const tokens = tokenize(
            "SELECT u.id, SUM(o.total) AS total FROM users u INNER JOIN orders o ON u.id = o.user_id WHERE u.tenant_id = ? GROUP BY u.id HAVING SUM(o.total) > 10 ORDER BY total DESC LIMIT 5 OFFSET 2",
        );
        expect(tokens.ok).toBe(true);
        if (!tokens.ok) {
            return;
        }

        const result = parse(tokens.value);
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.kind).toBe("SelectStatement");
        expect(result.value.selectItems).toHaveLength(2);
        expect(result.value.joins).toHaveLength(1);
        expect(result.value.groupBy).toHaveLength(1);
        expect(result.value.orderBy).toHaveLength(1);
        expect(result.value.limit?.offset?.kind).toBe("Literal");
    });

    test("rejects subqueries", () => {
        const tokens = tokenize("SELECT id FROM users WHERE id IN (SELECT user_id FROM orders)");
        expect(tokens.ok).toBe(true);
        if (!tokens.ok) {
            return;
        }

        const result = parse(tokens.value);
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnsupportedConstruct);
    });

    test("rejects unsupported statements", () => {
        const tokens = tokenize("UPDATE users SET name = 'x'");
        expect(tokens.ok).toBe(true);
        if (!tokens.ok) {
            return;
        }

        const result = parse(tokens.value);
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnsupportedStatement);
    });

    test("parses wildcard selects and comma-style limit offset", () => {
        const tokens = tokenize("SELECT u.*, * FROM users u LIMIT 2, 5");
        expect(tokens.ok).toBe(true);
        if (!tokens.ok) {
            return;
        }

        const result = parse(tokens.value);
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.selectItems[0]?.kind).toBe("SelectWildcardItem");
        expect(result.value.selectItems[1]?.kind).toBe("SelectWildcardItem");
        expect(result.value.limit?.offset?.kind).toBe("Literal");
        expect(result.value.limit?.count.kind).toBe("Literal");
    });

    test("rejects unexpected end of input", () => {
        const tokens = tokenize("SELECT id FROM");
        expect(tokens.ok).toBe(true);
        if (!tokens.ok) {
            return;
        }

        const result = parse(tokens.value);
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnexpectedEndOfInput);
    });

    test("parses quoted identifiers", () => {
        const tokens = tokenize("SELECT `name` FROM `users` AS `u` ORDER BY `u`.`name` ASC");
        expect(tokens.ok).toBe(true);
        if (!tokens.ok) {
            return;
        }

        const result = parse(tokens.value);
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.from?.alias?.quoted).toBe(true);
        expect(result.value.orderBy[0]?.direction).toBe("ASC");
    });

    test("parses select without from", () => {
        const tokens = tokenize("SELECT 1");
        expect(tokens.ok).toBe(true);
        if (!tokens.ok) {
            return;
        }

        const result = parse(tokens.value);
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.from).toBeUndefined();
        expect(result.value.selectItems).toHaveLength(1);
    });

    test("parses CURRENT_* expressions and trailing semicolon", () => {
        const inputs = [
            "SELECT now()",
            "SELECT (CURRENT_TIMESTAMP)",
            "SELECT (CURRENT_DATE)",
            "SELECT (CURRENT_TIME)",
            "SELECT CURRENT_TIME",
            "SELECT 1;",
        ];

        for (const sql of inputs) {
            const tokens = tokenize(sql);
            expect(tokens.ok).toBe(true);
            if (!tokens.ok) {
                continue;
            }

            const result = parse(tokens.value);
            expect(result.ok).toBe(true);
        }
    });

    test("rejects extra tokens after a semicolon", () => {
        const tokens = tokenize("SELECT 1; SELECT 2");
        expect(tokens.ok).toBe(true);
        if (!tokens.ok) {
            return;
        }

        const result = parse(tokens.value);
        expect(result.ok).toBe(false);
    });
});
