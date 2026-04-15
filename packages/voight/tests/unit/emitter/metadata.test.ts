import { describe, expect, test } from "vitest";

import { emit } from "../../../src/emitter";
import { bindStatement } from "../../_support/bind";

describe("emit metadata", () => {
    test("tracks parameter source offsets across nested subqueries in traversal order", () => {
        // Parameters are recorded by source offset, not by ordinal placeholder number.
        // This locks in the traversal order across nested query boundaries.
        const result = emit(
            bindStatement(
                "SELECT ? FROM users WHERE id IN (SELECT user_id FROM orders WHERE total > ? LIMIT ?) AND tenant_id = ?",
            ),
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.parameters).toEqual([7, 74, 82, 101]);
            expect(result.meta.parameterCount).toBe(4);
        }
    });

    test("emits CTE column lists explicitly", () => {
        // Explicit CTE column lists affect downstream binding, so the emitter must keep
        // them instead of collapsing to the inner projection names.
        const result = emit(
            bindStatement(
                "WITH recent_orders (owner_id) AS (SELECT user_id FROM orders) SELECT owner_id FROM recent_orders",
            ),
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.sql).toContain("WITH `recent_orders` (`owner_id`) AS");
        }
    });
});
