import { describe, expect, test } from "vitest";

import { compileStrict } from "../../_support/compile";

describe("parser consistency", () => {
    test("re-compiles emitted SQL successfully", () => {
        const queries = [
            "SELECT id, name FROM users WHERE age > 18 ORDER BY name ASC LIMIT 10",
            "SELECT u.id, o.total FROM users AS u INNER JOIN orders AS o ON o.user_id = u.id",
            "WITH recent AS (SELECT id FROM users LIMIT 5) SELECT id FROM recent",
            "SELECT id FROM users WHERE id IN (1, 2, 3)",
            "SELECT id FROM users WHERE name IS NOT NULL",
        ];

        for (const sql of queries) {
            const first = compileStrict(sql);
            expect(first.ok, `Expected first compile to succeed for ${sql}`).toBe(true);
            if (!first.ok || !first.emitted) {
                continue;
            }

            const second = compileStrict(first.emitted.sql);
            expect(second.ok, `Round-trip failed for ${sql}`).toBe(true);
        }
    });

    test("normalizes keyword casing consistently", () => {
        const uppercase = compileStrict("SELECT id FROM users WHERE age > 18");
        const lowercase = compileStrict("select id from users where age > 18");
        const mixed = compileStrict("Select Id From Users Where Age > 18");

        expect(uppercase.ok).toBe(true);
        expect(lowercase.ok).toBe(true);
        expect(mixed.ok).toBe(true);
        expect(uppercase.emitted?.sql).toBe(lowercase.emitted?.sql);
        expect(uppercase.emitted?.sql).toBe(mixed.emitted?.sql);
    });

    test("normalizes spacing consistently", () => {
        const compact = compileStrict("SELECT id FROM users");
        const padded = compileStrict("SELECT  id  FROM  users");
        const mixedWhitespace = compileStrict("SELECT\tid\nFROM\tusers");

        expect(compact.ok).toBe(true);
        expect(padded.ok).toBe(true);
        expect(mixedWhitespace.ok).toBe(true);
        expect(compact.emitted?.sql).toBe(padded.emitted?.sql);
        expect(compact.emitted?.sql).toBe(mixedWhitespace.emitted?.sql);
    });

    test("treats a BOM-prefixed query as a non-crashing boundary case", () => {
        expect(typeof compileStrict("\uFEFF SELECT id FROM users").ok).toBe("boolean");
    });
});
