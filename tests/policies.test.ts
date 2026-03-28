import { describe, expect, test } from "vitest";

import { analyze } from "../src/analyzer";
import { bind } from "../src/binder";
import { compile } from "../src/compiler";
import { DiagnosticCode } from "../src/diagnostics";
import { enforce } from "../src/enforcer";
import { tokenize } from "../src/lexer";
import { tenantScopingPolicy } from "../src/policies";
import { parse } from "../src/parser";
import { createTestCatalog } from "../src/testing";

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

describe("tenantScopingPolicy", () => {
    const policy = tenantScopingPolicy({
        tables: ["timeseries"],
        scopeColumn: "tenant_id",
        contextKey: "tenantId",
    });

    test("rewrites aliased table scans", () => {
        const result = compile("SELECT t.metric FROM timeseries AS t", {
            catalog: createTestCatalog(),
            dialect: "mysql",
            policies: [policy],
            policyContext: { tenantId: "tenant-123" },
            strict: true,
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe(
            "SELECT `t`.`metric` FROM `timeseries` AS `t` WHERE `t`.`tenant_id` = 'tenant-123'",
        );
    });

    test("rewrites scans inside CTEs", () => {
        const result = compile(
            "WITH scoped AS (SELECT metric FROM timeseries) SELECT metric FROM scoped",
            {
                catalog: createTestCatalog(),
                dialect: "mysql",
                policies: [policy],
                policyContext: { tenantId: "tenant-123" },
                strict: true,
            },
        );

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain(
            "WITH `scoped` AS (SELECT `timeseries`.`metric` FROM `timeseries` WHERE `timeseries`.`tenant_id` = 'tenant-123')",
        );
    });

    test("rewrites scans inside derived tables", () => {
        const result = compile("SELECT d.metric FROM (SELECT metric FROM timeseries) AS d", {
            catalog: createTestCatalog(),
            dialect: "mysql",
            policies: [policy],
            policyContext: { tenantId: "tenant-123" },
            strict: true,
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain(
            "(SELECT `timeseries`.`metric` FROM `timeseries` WHERE `timeseries`.`tenant_id` = 'tenant-123') AS `d`",
        );
    });

    test("injects scoped predicates for joined tables into JOIN ON", () => {
        const result = compile(
            "SELECT users.id FROM users LEFT JOIN timeseries AS ts ON ts.id = users.id WHERE users.tenant_id = ?",
            {
                catalog: createTestCatalog(),
                dialect: "mysql",
                policies: [policy],
                policyContext: { tenantId: "tenant-123" },
                strict: true,
            },
        );

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain(
            "LEFT JOIN `timeseries` AS `ts` ON `ts`.`id` = `users`.`id` AND `ts`.`tenant_id` = 'tenant-123'",
        );
        expect(result.emitted?.sql).not.toContain(
            "WHERE `users`.`tenant_id` = ? AND `ts`.`tenant_id` = 'tenant-123'",
        );
    });

    test("rejects OR-based bypasses during enforcement", () => {
        const bound = bindStatement(
            "SELECT metric FROM timeseries WHERE tenant_id = 'tenant-123' OR 1 = 1",
        );

        const analysis = analyze(bound);
        expect(analysis.ok).toBe(true);
        if (!analysis.ok) {
            return;
        }

        const result = enforce(bound, analysis.value, {
            policies: [policy],
            policyContext: { tenantId: "tenant-123" },
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
            DiagnosticCode.PolicyViolation,
        );
    });

    test("accepts additional filters when tenant scope is preserved with AND", () => {
        const bound = bindStatement(
            "SELECT metric FROM timeseries WHERE tenant_id = 'tenant-123' AND metric = 'cpu'",
        );

        const analysis = analyze(bound);
        expect(analysis.ok).toBe(true);
        if (!analysis.ok) {
            return;
        }

        const result = enforce(bound, analysis.value, {
            policies: [policy],
            policyContext: { tenantId: "tenant-123" },
        });

        expect(result.ok).toBe(true);
    });

    test("rewrites unsafe join predicates without changing tenant scope semantics", () => {
        const result = compile(
            "SELECT users.id FROM users LEFT JOIN timeseries AS ts ON ts.id = users.id OR 1 = 1",
            {
                catalog: createTestCatalog(),
                dialect: "mysql",
                policies: [policy],
                policyContext: { tenantId: "tenant-123" },
                strict: true,
            },
        );

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain(
            "LEFT JOIN `timeseries` AS `ts` ON (`ts`.`id` = `users`.`id` OR 1 = 1) AND `ts`.`tenant_id` = 'tenant-123'",
        );
    });
});
