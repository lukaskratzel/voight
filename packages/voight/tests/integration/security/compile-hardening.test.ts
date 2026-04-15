import { describe, expect, test } from "vitest";

import { DiagnosticCode } from "../../../src/core/diagnostics";
import { compileStrict } from "../../_support/compile";

function expectBlocked(sql: string) {
    const result = compileStrict(sql);
    expect(result.ok, `Expected rejection but query compiled: ${sql}`).toBe(false);
    return result;
}

describe("compile hardening", () => {
    test("rejects mutation and multi-statement inputs", () => {
        for (const sql of [
            "INSERT INTO users (id) VALUES (1)",
            "UPDATE users SET name = 'x'",
            "DELETE FROM users",
            "SELECT 1; DROP TABLE users",
            "SELECT 1; SELECT 2",
            "SET @a = 1",
            "SELECT id FROM users UNION SELECT id FROM orders",
        ]) {
            expectBlocked(sql);
        }
    });

    test("rejects comment-based and exotic-token bypass attempts", () => {
        for (const sql of [
            "SELECT id FROM users -- where 1=1",
            "SELECT id FROM users # comment",
            "SELECT id FROM users /* comment */",
            "SELECT id FROM users\uFF1B",
        ]) {
            expectBlocked(sql);
        }
    });

    test("rejects catalog escape attempts against system and cross-database tables", () => {
        const unknownTable = expectBlocked("SELECT * FROM information_schema.tables");
        expect(
            unknownTable.diagnostics.some(
                (diagnostic) => diagnostic.code === DiagnosticCode.UnknownTable,
            ),
        ).toBe(true);

        expectBlocked("SELECT user FROM mysql.user");
        expectBlocked("SELECT id FROM other_db.users");
        expectBlocked("SELECT * FROM performance_schema.threads");
    });
});
