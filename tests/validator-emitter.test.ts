import { describe, expect, test } from "vitest";

import { bind } from "../src/binder";
import { DiagnosticCode } from "../src/diagnostics";
import { emit } from "../src/emitter";
import { tokenize } from "../src/lexer";
import { parse } from "../src/parser";
import { createTestCatalog } from "../src/testing";
import { validate } from "../src/validator";

function bindStatement(sql: string) {
    const tokens = tokenize(sql);
    if (!tokens.ok) {
        throw new Error(tokens.diagnostics[0]?.message);
    }

    const parsed = parse(tokens.value);
    if (!parsed.ok) {
        throw new Error(parsed.diagnostics[0]?.message);
    }

    const bound = bind(parsed.value, createTestCatalog());
    if (!bound.ok) {
        throw new Error(bound.diagnostics[0]?.message);
    }

    return bound.value;
}

describe("validate", () => {
    test("rejects disallowed functions", () => {
        const bound = bindStatement("SELECT SUM(total) FROM orders");
        const result = validate(bound, {
            allowedFunctions: new Set(["count"]),
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.DisallowedFunction);
    });

    test("rejects excessive limits", () => {
        const bound = bindStatement("SELECT id FROM users LIMIT 999");
        const result = validate(bound, { maxLimit: 100 });

        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.LimitExceeded);
    });

    test("allows approved functions and nested expressions", () => {
        const bound = bindStatement("SELECT SUM(total) FROM orders WHERE NOT (tenant_id = ?)");
        const result = validate(bound, {
            allowedFunctions: new Set(["sum"]),
        });

        expect(result.ok).toBe(true);
    });
});

describe("emit", () => {
    test("emits canonical SQL from a bound statement", () => {
        const bound = bindStatement(
            "SELECT u.id, o.total AS amount FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE u.tenant_id = ? ORDER BY o.total DESC LIMIT 5",
        );

        const result = emit(bound);
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.sql).toBe(
            "SELECT `u`.`id`, `o`.`total` AS `amount` FROM `users` AS `u` LEFT JOIN `orders` AS `o` ON `u`.`id` = `o`.`user_id` WHERE `u`.`tenant_id` = ? ORDER BY `o`.`total` DESC LIMIT 5",
        );
        expect(result.value.parameters).toHaveLength(1);
    });

    test("emits comma-style input as canonical limit offset syntax", () => {
        const bound = bindStatement("SELECT * FROM users LIMIT 2, 5");

        const result = emit(bound);
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.sql).toBe("SELECT * FROM `users` LIMIT 5 OFFSET 2");
    });

    test("emits quoted identifiers for quoted input names", () => {
        const bound = bindStatement(
            "SELECT `u`.`name` FROM `users` AS `u` ORDER BY `u`.`name` ASC",
        );

        const result = emit(bound);
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.sql).toBe(
            "SELECT `u`.`name` FROM `users` AS `u` ORDER BY `u`.`name` ASC",
        );
    });

    test("emits projection-only selects and current keyword expressions", () => {
        const nowTokens = tokenize("SELECT now()");
        expect(nowTokens.ok).toBe(true);
        if (nowTokens.ok) {
            const nowParsed = parse(nowTokens.value);
            expect(nowParsed.ok).toBe(true);
            if (nowParsed.ok) {
                const nowEmitted = emit(nowParsed.value);
                expect(nowEmitted.ok).toBe(true);
                if (nowEmitted.ok) {
                    expect(nowEmitted.value.sql).toBe("SELECT `now`()");
                }
            }
        }

        const currentTokens = tokenize("SELECT CURRENT_TIME");
        expect(currentTokens.ok).toBe(true);
        if (currentTokens.ok) {
            const currentParsed = parse(currentTokens.value);
            expect(currentParsed.ok).toBe(true);
            if (currentParsed.ok) {
                const currentEmitted = emit(currentParsed.value);
                expect(currentEmitted.ok).toBe(true);
                if (currentEmitted.ok) {
                    expect(currentEmitted.value.sql).toBe("SELECT CURRENT_TIME");
                }
            }
        }
    });
});
