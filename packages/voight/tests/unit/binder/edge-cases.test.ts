import { describe, expect, test } from "vitest";

import { bind } from "../../../src/binder";
import { DiagnosticCode } from "../../../src/core/diagnostics";
import { createTestCatalog } from "../../../src/testing";
import { parseQuery } from "../../_support/parse";

describe("bind edge cases", () => {
    test("resolves SELECT aliases in ORDER BY", () => {
        // ORDER BY should resolve against projected aliases first, otherwise canonical
        // SQL like `SELECT id AS user_id ... ORDER BY user_id` regresses at bind time.
        const result = bind(
            parseQuery("SELECT id AS user_id FROM users ORDER BY user_id"),
            createTestCatalog(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.body.orderBy[0]?.kind).toBe("BoundOrderByItem");
        expect(result.value.body.orderBy[0]?.expression.kind).toBe("BoundColumnReference");
        if (result.value.body.orderBy[0]?.expression.kind === "BoundColumnReference") {
            expect(result.value.body.orderBy[0].expression.column.name).toBe("id");
        }
    });

    test("binds explicit CTE column lists into the derived table schema", () => {
        // CTE column renaming changes the visible schema for downstream references, so
        // the binder must expose the renamed output column instead of the inner name.
        const result = bind(
            parseQuery(
                "WITH recent_orders (owner_id) AS (SELECT user_id FROM orders) SELECT owner_id FROM recent_orders",
            ),
            createTestCatalog(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.body.from?.table.columns.has("owner_id")).toBe(true);
    });

    test("rejects duplicate CTE names", () => {
        // Duplicate CTE names create ambiguous scope and can hide earlier bindings, so
        // this must fail before later stages reason about the query.
        const result = bind(
            parseQuery(
                "WITH scoped AS (SELECT id FROM users), scoped AS (SELECT id FROM orders) SELECT id FROM scoped",
            ),
            createTestCatalog(),
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.DuplicateAlias);
        }
    });

    test("rejects explicit CTE column lists whose arity does not match the query output", () => {
        const result = bind(
            parseQuery("WITH scoped (id, email) AS (SELECT id FROM users) SELECT id FROM scoped"),
            createTestCatalog(),
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.InvalidColumnArity);
            expect(result.diagnostics[0]?.message).toContain('CTE "scoped" declares 2 columns');
        }
    });
});
