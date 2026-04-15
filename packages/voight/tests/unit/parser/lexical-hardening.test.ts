import { describe, expect, test } from "vitest";

import { compileStrict } from "../../_support/compile";

describe("parser lexical hardening", () => {
    test("keeps SQL-looking payloads contained inside backtick identifiers", () => {
        const result = compileStrict("SELECT id AS `; DROP TABLE users; --` FROM users");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("`; drop table users; --`");
    });

    test("re-escapes embedded backticks inside quoted identifiers", () => {
        const result = compileStrict("SELECT id AS `col`` FROM users; --` FROM users");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("``");
    });

    test("rejects unicode and visual-confusion characters inside identifiers", () => {
        for (const sql of [
            "SELECT id FROM us\u00E9rs",
            "SELECT id AS `caf\u00E9` FROM users",
            "SELECT id AS `a\u200Bb` FROM users",
            "SELECT id AS `\u0430dmin` FROM users",
            "SELECT id AS `\u202Esresu\u202C` FROM users",
        ]) {
            expect(compileStrict(sql).ok, `Expected rejection for ${sql}`).toBe(false);
        }
    });

    test("preserves unicode content inside string literals", () => {
        const result = compileStrict("SELECT id FROM users WHERE name = '\u00E9mile'");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("'\u00E9mile'");
    });

    test("accepts supported whitespace but rejects control-character separators", () => {
        expect(compileStrict("SELECT\t\nid\n\tFROM\n\tusers").ok).toBe(true);
        expect(compileStrict("SELECT\r\nid\r\nFROM\r\nusers").ok).toBe(true);
        expect(compileStrict("SELECT\fid FROM users").ok).toBe(false);
        expect(compileStrict("SELECT\vid FROM users").ok).toBe(false);
    });

    test("rejects non-printable control characters in the token stream", () => {
        for (const sql of [
            "SELECT\x08id FROM users",
            "SELECT\x07id FROM users",
            "SELECT\x1Bid FROM users",
            "SELECT\x7Fid FROM users",
        ]) {
            expect(compileStrict(sql).ok, `Expected rejection for ${JSON.stringify(sql)}`).toBe(
                false,
            );
        }
    });

    test("accepts emoji inside strings but not as standalone tokens", () => {
        expect(compileStrict("SELECT id FROM users WHERE name = '\u{1F600}'").ok).toBe(true);
        expect(compileStrict("SELECT \u{1F600} FROM users").ok).toBe(false);
    });
});
