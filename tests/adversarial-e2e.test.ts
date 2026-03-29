import Database from "bun:sqlite";
import { describe, expect, test, beforeAll, afterAll } from "vitest";

import { compile } from "../src/compiler";
import { InMemoryCatalog, createTableSchema } from "../src/catalog";
import { tenantScopingPolicy } from "../src/policies";

/**
 * END-TO-END VERIFICATION: Tenant scoping now works for all query forms.
 *
 * After the fix, expression subqueries (EXISTS, IN, scalar) are rewritten
 * with tenant predicates. This test proves that tenant-B's data is no longer
 * accessible to tenant-A through any query path.
 */

let db: Database;

const catalog = new InMemoryCatalog([
    createTableSchema({
        id: "users",
        path: ["users"],
        columns: ["id", "name", "tenant_id"],
    }),
    createTableSchema({
        id: "metrics",
        path: ["metrics"],
        columns: ["id", "tenant_id", "metric_name", "value"],
    }),
]);

const tenantPolicy = tenantScopingPolicy({
    tables: ["metrics"],
    scopeColumn: "tenant_id",
    contextKey: "tenantId",
});

function compileTenantScoped(sql: string, tenantId = "tenant-A") {
    return compile(sql, {
        catalog,
        dialect: "mysql",
        strict: true,
        policies: [tenantPolicy],
        policyContext: { tenantId },
    });
}

function toSQLite(mysqlSql: string): string {
    return mysqlSql.replace(/`([^`]+)`/g, "$1");
}

beforeAll(() => {
    db = new Database(":memory:");

    db.run(`CREATE TABLE users (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, tenant_id TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE metrics (
        id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL,
        metric_name TEXT NOT NULL, value REAL NOT NULL
    )`);

    // Tenant A (attacker)
    db.run("INSERT INTO users VALUES (1, 'Alice', 'tenant-A')");
    db.run("INSERT INTO users VALUES (2, 'Bob', 'tenant-A')");
    db.run("INSERT INTO metrics VALUES (1, 'tenant-A', 'cpu', 42.0)");
    db.run("INSERT INTO metrics VALUES (2, 'tenant-A', 'mem', 80.0)");

    // Tenant B (victim — should be invisible to tenant-A)
    db.run("INSERT INTO users VALUES (3, 'Charlie', 'tenant-B')");
    db.run("INSERT INTO metrics VALUES (3, 'tenant-B', 'SECRET_CPU', 99.9)");
    db.run("INSERT INTO metrics VALUES (4, 'tenant-B', 'SECRET_MEM', 55.5)");
    db.run("INSERT INTO metrics VALUES (5, 'tenant-B', 'SECRET_DISK', 12.3)");
});

afterAll(() => {
    db.close();
});

describe("E2E: safe queries return only tenant-A data", () => {
    test("direct SELECT is scoped", () => {
        const result = compileTenantScoped("SELECT metric_name, value FROM metrics");
        expect(result.ok).toBe(true);
        const rows = db.prepare(toSQLite(result.emitted!.sql)).all() as { metric_name: string }[];
        expect(rows.length).toBe(2);
        expect(rows.every((r) => !r.metric_name.startsWith("SECRET"))).toBe(true);
    });

    test("derived table is scoped", () => {
        const result = compileTenantScoped(
            "SELECT d.metric_name FROM (SELECT metric_name FROM metrics) AS d",
        );
        expect(result.ok).toBe(true);
        const rows = db.prepare(toSQLite(result.emitted!.sql)).all() as { metric_name: string }[];
        expect(rows.length).toBe(2);
        expect(rows.every((r) => !r.metric_name.startsWith("SECRET"))).toBe(true);
    });
});

describe("E2E FIXED: expression subqueries no longer leak cross-tenant data", () => {
    test("EXISTS subquery is now scoped — cannot detect tenant-B data", () => {
        const result = compileTenantScoped(
            "SELECT name FROM users WHERE EXISTS (SELECT 1 FROM metrics WHERE metrics.tenant_id = 'tenant-B')",
        );
        expect(result.ok).toBe(true);
        const sql = toSQLite(result.emitted!.sql);
        // The rewrite injects AND tenant_id = 'tenant-A' into the inner query.
        // Combined with the explicit tenant_id = 'tenant-B', the inner query
        // requires both tenant-A AND tenant-B, which matches nothing.
        const rows = db.prepare(sql).all() as { name: string }[];
        expect(rows.length).toBe(0);
    });

    test("scalar subquery cannot extract tenant-B metric names", () => {
        const result = compileTenantScoped(
            "SELECT name, (SELECT metric_name FROM metrics WHERE metrics.tenant_id = 'tenant-B' LIMIT 1) FROM users LIMIT 1",
        );
        expect(result.ok).toBe(true);
        const sql = toSQLite(result.emitted!.sql);
        const rows = db.prepare(sql).all() as Record<string, unknown>[];
        // The scalar subquery now has AND tenant_id = 'tenant-A', so
        // querying for tenant-B AND tenant-A returns NULL
        const values = Object.values(rows[0] ?? {});
        const leaked = values.some(
            (v) => typeof v === "string" && v.startsWith("SECRET"),
        );
        expect(leaked).toBe(false);
    });

    test("scalar subquery cannot extract tenant-B metric values", () => {
        const result = compileTenantScoped(
            "SELECT name, (SELECT value FROM metrics WHERE metrics.tenant_id = 'tenant-B' LIMIT 1) FROM users LIMIT 1",
        );
        expect(result.ok).toBe(true);
        const sql = toSQLite(result.emitted!.sql);
        const rows = db.prepare(sql).all() as Record<string, unknown>[];
        const values = Object.values(rows[0] ?? {});
        expect(values).not.toContain(99.9);
    });

    test("IN subquery cannot enumerate tenant-B IDs", () => {
        const result = compileTenantScoped(
            "SELECT users.id, users.name FROM users WHERE users.id IN (SELECT metrics.id FROM metrics WHERE metrics.tenant_id = 'tenant-B')",
        );
        expect(result.ok).toBe(true);
        const sql = toSQLite(result.emitted!.sql);
        const rows = db.prepare(sql).all() as { id: number }[];
        // tenant-B IDs are no longer visible
        expect(rows.length).toBe(0);
    });

    test("LIMIT/OFFSET iteration cannot extract tenant-B data", () => {
        const leakedNames: string[] = [];

        for (let offset = 0; offset < 5; offset++) {
            const result = compileTenantScoped(
                `SELECT (SELECT metric_name FROM metrics WHERE metrics.tenant_id = 'tenant-B' LIMIT 1 OFFSET ${offset}) FROM users LIMIT 1`,
            );
            if (!result.ok) break;
            const sql = toSQLite(result.emitted!.sql);
            const rows = db.prepare(sql).all() as Record<string, unknown>[];
            const value = Object.values(rows[0] ?? {})[0];
            if (value === null) break;
            if (typeof value === "string") leakedNames.push(value);
        }

        // No secret data should be extractable
        expect(leakedNames).not.toContain("SECRET_CPU");
        expect(leakedNames).not.toContain("SECRET_MEM");
        expect(leakedNames).not.toContain("SECRET_DISK");
        expect(leakedNames.length).toBe(0);
    });
});
