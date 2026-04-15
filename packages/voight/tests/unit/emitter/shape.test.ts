import { describe, expect, test } from "vitest";

import { compileStrict, compileWithAllowedFunctions } from "../../_support/compile";

describe("emitter expression shape", () => {
    test("parenthesizes OR groups inside AND expressions", () => {
        const result = compileStrict(
            "SELECT id FROM users WHERE age = 1 AND (name = 'a' OR name = 'b')",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("(`users`.`name` = 'a' OR `users`.`name` = 'b')");
    });

    test("preserves explicit grouping for non-associative arithmetic", () => {
        const result = compileStrict("SELECT age - (1 - 2) FROM users");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("(1 - 2)");
    });

    test("keeps NOT applied to the whole grouped boolean expression", () => {
        const result = compileStrict("SELECT id FROM users WHERE NOT (age = 1 OR age = 2)");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("NOT (`users`.`age` = 1 OR `users`.`age` = 2)");
    });

    test("does not add unnecessary grouping for same-precedence arithmetic", () => {
        const result = compileStrict("SELECT age + 1 + 2 FROM users");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toBe("SELECT `users`.`age` + 1 + 2 FROM `users`");
    });

    test("emits unary minus before function calls without changing grouping", () => {
        const result = compileWithAllowedFunctions("SELECT -COUNT(id) FROM users");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("-count(`users`.`id`)");
    });
});

describe("emitter select shape", () => {
    test("expands qualified wildcards before emission", () => {
        const result = compileStrict(
            "SELECT u.*, o.* FROM users AS u INNER JOIN orders AS o ON u.id = o.user_id",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("`u`.`id`");
        expect(result.emitted?.sql).toContain("`o`.`id`");
        expect(result.emitted?.sql).not.toContain(".*");
    });

    test("emits null checks and IN predicates without rewriting their shape", () => {
        const result = compileStrict(
            "SELECT id FROM users WHERE name IS NOT NULL AND id NOT IN (1, 2, 3)",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("IS NOT NULL");
        expect(result.emitted?.sql).toContain("NOT IN (1, 2, 3)");
    });
});
