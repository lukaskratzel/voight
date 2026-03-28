import { describe, expect, test } from "bun:test";

import { compile } from "../src/compiler";
import { CompilerStage, DiagnosticCode, formatDiagnostic } from "../src/diagnostics";
import { createSourceFile } from "../src/source";
import { createTestCatalog } from "../src/testing";

describe("compile", () => {
    test("runs the full pipeline for a valid query", () => {
        const result = compile(
            "SELECT id, name FROM users WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 10",
            {
                catalog: createTestCatalog(),
                dialect: "mysql",
                allowedFunctions: new Set(["sum", "count"]),
                strict: true,
            },
        );

        expect(result.ok).toBe(true);
        expect(result.terminalStage).toBe(CompilerStage.Emitter);
        expect(result.emitted?.sql).toBe(
            "SELECT `users`.`id`, `users`.`name` FROM `users` WHERE `users`.`tenant_id` = ? ORDER BY `users`.`created_at` DESC LIMIT 10",
        );
    });

    test("short-circuits on parse failure", () => {
        const result = compile("WITH cte AS (SELECT id FROM users) SELECT id FROM cte", {
            catalog: createTestCatalog(),
            dialect: "mysql",
            strict: true,
        });

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Parser);
        expect(result.stages.bind).toBeUndefined();
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnsupportedStatement);
    });

    test("renders descriptive diagnostics with source locations", () => {
        const result = compile("SELECT id FROM missing", {
            catalog: createTestCatalog(),
            dialect: "mysql",
            strict: true,
        });

        expect(result.ok).toBe(false);
        const diagnostic = result.diagnostics[0];
        expect(diagnostic?.code).toBe(DiagnosticCode.UnknownTable);
        expect(diagnostic?.primarySpan).toEqual({ start: 15, end: 22 });

        const formatted = formatDiagnostic(diagnostic!, createSourceFile("SELECT id FROM missing"));
        expect(formatted).toContain("binder/unknown-table");
        expect(formatted).toContain("1:16-1:23");
    });

    test("short-circuits on lexical failure before parsing", () => {
        const result = compile("SELECT id FROM users @", {
            catalog: createTestCatalog(),
            dialect: "mysql",
            strict: true,
        });

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Lexer);
        expect(result.stages.parse).toBeUndefined();
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnexpectedCharacter);
    });

    test("short-circuits on validator failure before emit", () => {
        const result = compile("SELECT SUM(total) FROM orders LIMIT 1000", {
            catalog: createTestCatalog(),
            dialect: "mysql",
            allowedFunctions: new Set(["count"]),
            maxLimit: 100,
            strict: true,
        });

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Validator);
        expect(result.stages.emit).toBeUndefined();
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
            DiagnosticCode.DisallowedFunction,
        );
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
            DiagnosticCode.LimitExceeded,
        );
    });

    test("preserves bound artifacts on validator failure", () => {
        const result = compile("SELECT SUM(total) FROM orders", {
            catalog: createTestCatalog(),
            dialect: "mysql",
            allowedFunctions: new Set(["count"]),
            strict: true,
        });

        expect(result.ok).toBe(false);
        expect(result.ast?.kind).toBe("SelectStatement");
        expect(result.bound?.kind).toBe("BoundSelectStatement");
        expect(result.emitted).toBeUndefined();
    });

    test("supports projection-only and current temporal selects", () => {
        const inputs = [
            ["SELECT 1", "SELECT 1"],
            ["SELECT now()", "SELECT `now`()"],
            ["SELECT (CURRENT_TIMESTAMP)", "SELECT (CURRENT_TIMESTAMP)"],
            ["SELECT (CURRENT_DATE)", "SELECT (CURRENT_DATE)"],
            ["SELECT (CURRENT_TIME)", "SELECT (CURRENT_TIME)"],
            ["SELECT CURRENT_TIME", "SELECT CURRENT_TIME"],
            ["SELECT 1;", "SELECT 1"],
        ] as const;

        for (const [sql, expected] of inputs) {
            const result = compile(sql, {
                catalog: createTestCatalog(),
                dialect: "mysql",
                strict: true,
            });

            expect(result.ok).toBe(true);
            expect(result.emitted?.sql).toBe(expected);
        }
    });

    test("preserves large numeric literals as exact strings", () => {
        const sql = "SELECT 9007199254740993123456789";
        const result = compile(sql, {
            catalog: createTestCatalog(),
            dialect: "mysql",
            strict: true,
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe(sql);
    });

    test("rejects non-whitespace content after a trailing semicolon", () => {
        const result = compile("SELECT 1; SELECT 2", {
            catalog: createTestCatalog(),
            dialect: "mysql",
            strict: true,
        });

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Parser);
    });

    test("supports a complex query with a derived table, IN list, and alias ordering", () => {
        const sql = `SELECT
  u.id,
  u.email,
  COALESCE(p.display_name, u.email) AS name,
  COUNT(o.id) AS order_count,
  SUM(o.total_cents) / 100.0 AS revenue
FROM users AS u
LEFT JOIN profiles p ON p.user_id = u.id AND p.deleted_at IS NULL
INNER JOIN (
  SELECT user_id, id, total_cents, created_at
  FROM orders
  WHERE status IN ('paid', 'shipped')
    AND created_at >= '2024-01-01'
) AS o ON o.user_id = u.id
WHERE u.age > 18
GROUP BY u.id, u.email, p.display_name
HAVING COUNT(o.id) >= 0
ORDER BY revenue ASC
LIMIT 100 OFFSET 20`;

        const result = compile(sql, {
            catalog: createTestCatalog(),
            dialect: "mysql",
            strict: true,
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain(
            "ORDER BY `sum`(`o`.`total_cents`) / 100.0 ASC",
        );
        expect(result.emitted?.sql).toContain(
            "WHERE `status` IN ('paid', 'shipped') AND `created_at` >= '2024-01-01'",
        );
        expect(result.emitted?.sql).toContain(
            "INNER JOIN (SELECT `user_id`, `id`, `total_cents`, `created_at` FROM `orders` WHERE `status` IN ('paid', 'shipped') AND `created_at` >= '2024-01-01') AS `o`",
        );
    });

    test("rejects a trailing comma in the select list", () => {
        const result = compile("SELECT u.id, FROM users AS u", {
            catalog: createTestCatalog(),
            dialect: "mysql",
            strict: true,
        });

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Parser);
    });
});
