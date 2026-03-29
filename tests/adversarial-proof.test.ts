import { describe, expect, test } from "vitest";

import { compile } from "../src/compiler";
import { tenantScopingPolicy } from "../src/policies";
import { createTestCatalog } from "../src/testing";

/**
 * Post-fix verification: expression subqueries are now tenant-scoped.
 *
 * Previously, the rewrite and enforce phases did not traverse subqueries
 * inside expressions (EXISTS, IN, scalar). After the fix, all paths
 * correctly inject tenant predicates.
 */

const catalog = createTestCatalog();
const tenantPolicy = tenantScopingPolicy({
    tables: ["timeseries"],
    scopeColumn: "tenant_id",
    contextKey: "tenantId",
});

function compileTenantScoped(sql: string) {
    return compile(sql, {
        catalog,
        dialect: "mysql",
        strict: true,
        policies: [tenantPolicy],
        policyContext: { tenantId: "tenant-123" },
    });
}

describe("FIXED: expression subqueries are now tenant-scoped", () => {
    test("EXISTS — tenant predicate injected into inner query", () => {
        const result = compileTenantScoped(
            "SELECT id FROM users WHERE EXISTS (SELECT 1 FROM timeseries WHERE timeseries.id = users.id)",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });

    test("scalar subquery in SELECT — tenant predicate injected", () => {
        const result = compileTenantScoped(
            "SELECT id, (SELECT metric FROM timeseries LIMIT 1) FROM users",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });

    test("scalar subquery in WHERE — tenant predicate injected", () => {
        const result = compileTenantScoped(
            "SELECT id FROM users WHERE name = (SELECT metric FROM timeseries LIMIT 1)",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });

    test("IN subquery — tenant predicate injected", () => {
        const result = compileTenantScoped(
            "SELECT id FROM users WHERE id IN (SELECT timeseries.id FROM timeseries)",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });

    test("NOT IN subquery — tenant predicate injected", () => {
        const result = compileTenantScoped(
            "SELECT id FROM users WHERE id NOT IN (SELECT timeseries.id FROM timeseries)",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });

    test("HAVING subquery — both outer and inner scoped", () => {
        const result = compileTenantScoped(
            "SELECT tenant_id, COUNT(id) FROM timeseries GROUP BY tenant_id HAVING COUNT(id) > (SELECT COUNT(id) FROM timeseries)",
        );
        expect(result.ok).toBe(true);
        const matches = result.emitted!.sql.match(/tenant-123/g) ?? [];
        expect(matches.length).toBe(2); // Both outer and inner now scoped
    });

    test("derived table in FROM — still works (regression check)", () => {
        const result = compileTenantScoped(
            "SELECT d.metric FROM (SELECT metric FROM timeseries) AS d",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });

    test("CTE body — still works (regression check)", () => {
        const result = compileTenantScoped(
            "WITH ts AS (SELECT metric FROM timeseries) SELECT metric FROM ts",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });
});
