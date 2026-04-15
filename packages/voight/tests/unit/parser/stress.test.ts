import { describe, expect, test } from "vitest";

import { compileStrict } from "../../_support/compile";

describe("parser stress and consistency", () => {
    test("handles moderately deep parenthesized expressions without crashing", () => {
        const depth = 100;
        const sql = `SELECT ${"(".repeat(depth)}1${")".repeat(depth)}`;

        expect(typeof compileStrict(sql).ok).toBe("boolean");
    });

    test("handles very long quoted identifiers within the performance budget", () => {
        const escapedPairs = "``".repeat(5000);
        const sql = `SELECT id AS \`${escapedPairs}\` FROM users`;

        const start = performance.now();
        const result = compileStrict(sql);
        const elapsed = performance.now() - start;

        expect(typeof result.ok).toBe("boolean");
        expect(elapsed).toBeLessThan(2000);
    });

    test("accepts very long string literals", () => {
        const longStr = "a".repeat(20000);
        expect(compileStrict(`SELECT id FROM users WHERE name = '${longStr}'`).ok).toBe(true);
    });

    test("produces stable output for repeated and equivalent input", () => {
        const sql = "SELECT id, name FROM users WHERE age > 18 ORDER BY name LIMIT 10";
        const first = compileStrict(sql);
        const second = compileStrict(sql);
        const lower = compileStrict(
            "select id, name from users where age > 18 order by name limit 10",
        );
        const spaced = compileStrict(
            "SELECT\tid,\nname FROM users WHERE age > 18 ORDER BY name LIMIT 10",
        );

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(lower.ok).toBe(true);
        expect(spaced.ok).toBe(true);
        expect(first.emitted?.sql).toBe(second.emitted?.sql);
        expect(first.emitted?.sql).toBe(lower.emitted?.sql);
        expect(first.emitted?.sql).toBe(spaced.emitted?.sql);
    });
});
