import { DatabaseSync } from "node:sqlite";
import { describe, expect, test, beforeAll, afterAll } from "vitest";

import { compile } from "../../src/compiler";
import { InMemoryCatalog, createTableSchema } from "../../src/catalog";
import { tenantScopingPolicy } from "../../src/policies";

/**
 * END-TO-END VERIFICATION: Tenant scoping now works for all query forms.
 *
 * After the fix, expression subqueries (EXISTS, IN, scalar) are rewritten
 * with tenant predicates. This test proves that tenant-B's data is no longer
 * accessible to tenant-A through any query path.
 */

let db: DatabaseSync;

const catalog = new InMemoryCatalog([
    createTableSchema({
        path: ["users"],
        columns: ["id", "name", "tenant_id"],
    }),
    createTableSchema({
        path: ["metrics"],
        columns: ["id", "tenant_id", "metric_name", "value"],
    }),
    createTableSchema({
        path: ["orders"],
        columns: ["id", "user_id", "tenant_id", "total"],
    }),
    createTableSchema({
        path: ["subscriptions"],
        columns: ["id", "user_id", "account_id", "plan_name"],
    }),
]);

const tenantPolicy = tenantScopingPolicy({
    tables: ["metrics"],
    scopeColumn: "tenant_id",
    contextKey: "tenantId",
});

const joinTenantPolicy = tenantScopingPolicy({
    tables: ["users", "orders"],
    scopeColumn: "tenant_id",
    contextKey: "tenantId",
});

const mixedColumnTenantPolicy = tenantScopingPolicy({
    scopes: [
        {
            tables: ["users"],
            scopeColumn: "tenant_id",
            contextKey: "tenantId",
        },
        {
            tables: ["subscriptions"],
            scopeColumn: "account_id",
            contextKey: "tenantId",
        },
    ],
});

function compileTenantScoped(sql: string, tenantId = "tenant-A") {
    return compile(sql, {
        catalog,
        policies: [tenantPolicy],
        policyContext: { tenantId },
        debug: true,
    });
}

function compileJoinTenantScoped(sql: string, tenantId = "tenant-A") {
    return compile(sql, {
        catalog,
        policies: [joinTenantPolicy],
        policyContext: { tenantId },
        debug: true,
    });
}

function compileMixedColumnTenantScoped(sql: string, tenantId = "tenant-A") {
    return compile(sql, {
        catalog,
        policies: [mixedColumnTenantPolicy],
        policyContext: { tenantId },
        debug: true,
    });
}

function toSQLite(mysqlSql: string): string {
    return mysqlSql.replace(/`([^`]+)`/g, "$1");
}

beforeAll(() => {
    db = new DatabaseSync(":memory:");

    db.exec(`CREATE TABLE users (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, tenant_id TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE metrics (
        id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL,
        metric_name TEXT NOT NULL, value REAL NOT NULL
    )`);
    db.exec(`CREATE TABLE orders (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
        tenant_id TEXT NOT NULL, total REAL NOT NULL
    )`);
    db.exec(`CREATE TABLE subscriptions (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
        account_id TEXT NOT NULL, plan_name TEXT NOT NULL
    )`);

    // Tenant A (attacker)
    db.exec("INSERT INTO users VALUES (1, 'Alice', 'tenant-A')");
    db.exec("INSERT INTO users VALUES (2, 'Bob', 'tenant-A')");
    db.exec("INSERT INTO metrics VALUES (1, 'tenant-A', 'cpu', 42.0)");
    db.exec("INSERT INTO metrics VALUES (2, 'tenant-A', 'mem', 80.0)");
    db.exec("INSERT INTO orders VALUES (10, 2, 'tenant-A', 50.0)");
    db.exec("INSERT INTO subscriptions VALUES (20, 2, 'tenant-A', 'starter')");

    // Tenant B (victim — should be invisible to tenant-A)
    db.exec("INSERT INTO users VALUES (3, 'Charlie', 'tenant-B')");
    db.exec("INSERT INTO metrics VALUES (3, 'tenant-B', 'SECRET_CPU', 99.9)");
    db.exec("INSERT INTO metrics VALUES (4, 'tenant-B', 'SECRET_MEM', 55.5)");
    db.exec("INSERT INTO metrics VALUES (5, 'tenant-B', 'SECRET_DISK', 12.3)");
    db.exec("INSERT INTO orders VALUES (11, 1, 'tenant-B', 999.0)");
    db.exec("INSERT INTO orders VALUES (12, 3, 'tenant-B', 77.0)");
    db.exec("INSERT INTO subscriptions VALUES (21, 1, 'tenant-B', 'secret-enterprise')");
    db.exec("INSERT INTO subscriptions VALUES (22, 3, 'tenant-B', 'victim-plan')");
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
        const leaked = values.some((v) => typeof v === "string" && v.startsWith("SECRET"));
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

describe("E2E: tenant scoping across joined tables", () => {
    test("INNER JOIN scopes both sides and blocks cross-tenant join collisions", () => {
        const result = compileJoinTenantScoped(
            "SELECT u.name, o.total FROM users AS u INNER JOIN orders AS o ON o.user_id = u.id ORDER BY u.id",
        );
        expect(result.ok).toBe(true);
        const rows = db.prepare(toSQLite(result.emitted!.sql)).all() as Array<{
            name: string;
            total: number;
        }>;

        expect(rows).toEqual([{ name: "Bob", total: 50 }]);
    });

    test("LEFT JOIN keeps tenant-A rows while filtering tenant-B matches from the joined table", () => {
        const result = compileJoinTenantScoped(
            "SELECT u.name, o.total FROM users AS u LEFT JOIN orders AS o ON o.user_id = u.id ORDER BY u.id",
        );
        expect(result.ok).toBe(true);
        const rows = db.prepare(toSQLite(result.emitted!.sql)).all() as Array<{
            name: string;
            total: number | null;
        }>;

        expect(rows).toEqual([
            { name: "Alice", total: null },
            { name: "Bob", total: 50 },
        ]);
    });

    test("explicit scope rules can scope joined tables that use different column names", () => {
        const result = compileMixedColumnTenantScoped(
            "SELECT u.name, s.plan_name FROM users AS u LEFT JOIN subscriptions AS s ON s.user_id = u.id ORDER BY u.id",
        );
        expect(result.ok).toBe(true);
        const rows = db.prepare(toSQLite(result.emitted!.sql)).all() as Array<{
            name: string;
            plan_name: string | null;
        }>;

        expect(rows).toEqual([
            { name: "Alice", plan_name: null },
            { name: "Bob", plan_name: "starter" },
        ]);
    });
});
