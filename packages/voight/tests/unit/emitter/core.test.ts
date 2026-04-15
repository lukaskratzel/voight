import { describe, expect, test } from "vitest";

import { emit } from "../../../src/emitter";
import { bindStatement } from "../../_support/bind";

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

        expect(result.value.sql).toBe(
            "SELECT `users`.`id`, `users`.`name`, `users`.`email`, `users`.`age`, `users`.`tenant_id`, `users`.`created_at` FROM `users` LIMIT 5 OFFSET 2",
        );
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

    test("escapes trailing backslashes in string literals for MySQL-safe output", () => {
        const result = emit(bindStatement("SELECT 'abc\\'"));
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.sql).toBe("SELECT 'abc\\\\'");
    });

    test("emits projection-only selects and current keyword expressions", () => {
        const nowEmitted = emit(bindStatement("SELECT now()"));
        expect(nowEmitted.ok).toBe(true);
        if (nowEmitted.ok) {
            expect(nowEmitted.value.sql).toBe("SELECT now()");
        }

        const currentEmitted = emit(bindStatement("SELECT CURRENT_TIME"));
        expect(currentEmitted.ok).toBe(true);
        if (currentEmitted.ok) {
            expect(currentEmitted.value.sql).toBe("SELECT CURRENT_TIME");
        }
    });

    test("emits LIKE predicates with safely escaped patterns", () => {
        const result = emit(bindStatement("SELECT id FROM users WHERE name LIKE 'O''Brien%'"));
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.sql).toBe(
            "SELECT `users`.`id` FROM `users` WHERE `users`.`name` LIKE 'O''Brien%'",
        );
    });
});
