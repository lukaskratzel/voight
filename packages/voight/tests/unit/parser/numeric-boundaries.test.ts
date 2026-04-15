import { describe, expect, test } from "vitest";

import { compileStrict } from "../../_support/compile";

describe("parser numeric boundaries", () => {
    test("preserves basic numeric literal forms", () => {
        expect(compileStrict("SELECT 0 FROM users").ok).toBe(true);
        expect(compileStrict("SELECT 007 FROM users").ok).toBe(true);
        expect(compileStrict("SELECT 3.14 FROM users").ok).toBe(true);
        expect(compileStrict("SELECT -42 FROM users").ok).toBe(true);
        expect(compileStrict("SELECT id FROM users LIMIT 0").ok).toBe(true);
        expect(compileStrict("SELECT id FROM users LIMIT -1").ok).toBe(true);
    });

    test("rejects malformed decimal forms", () => {
        expect(compileStrict("SELECT .5 FROM users").ok).toBe(false);
        expect(compileStrict("SELECT 1.2.3 FROM users").ok).toBe(false);
        expect(compileStrict("SELECT 42. FROM users").ok).toBe(false);
    });

    test("treats hex and scientific notation as non-native number forms", () => {
        expect(typeof compileStrict("SELECT 0xFF FROM users").ok).toBe("boolean");
        expect(typeof compileStrict("SELECT 1e5 FROM users").ok).toBe("boolean");
    });

    test("still enforces extremely large LIMIT values through policy checks", () => {
        const result = compileStrict("SELECT id FROM users LIMIT 99999999999999999999999999999", {
            maxLimit: 100,
        });
        expect(result.ok).toBe(false);
    });
});
