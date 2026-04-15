import { describe, expect, test } from "vitest";

import { compileStrict } from "../../_support/compile";

describe("resource boundaries", () => {
    test("deeply nested subqueries complete without crashing", () => {
        let sql = "SELECT id FROM users";
        for (let depth = 0; depth < 20; depth++) {
            sql = `SELECT id FROM users WHERE id IN (${sql})`;
        }

        expect(typeof compileStrict(sql).ok).toBe("boolean");
    });

    test("many CTEs complete without crashing", () => {
        const ctes = Array.from(
            { length: 50 },
            (_, index) => `cte${index} AS (SELECT id FROM users)`,
        ).join(", ");
        const sql = `WITH ${ctes} SELECT id FROM cte0`;

        expect(typeof compileStrict(sql).ok).toBe("boolean");
    });

    test("large IN lists stay within the parser/compiler boundary", () => {
        const items = Array.from({ length: 500 }, (_, index) => String(index)).join(", ");
        const sql = `SELECT id FROM users WHERE id IN (${items})`;

        expect(typeof compileStrict(sql).ok).toBe("boolean");
    });

    test("many joins complete without crashing", () => {
        let sql = "SELECT u0.id FROM users AS u0";
        for (let index = 1; index <= 20; index++) {
            sql += ` INNER JOIN users AS u${index} ON u${index}.id = u${index - 1}.id`;
        }

        expect(typeof compileStrict(sql).ok).toBe("boolean");
    });
});
