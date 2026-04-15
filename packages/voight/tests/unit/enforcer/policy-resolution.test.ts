import { describe, expect, test } from "vitest";

import { PolicyConflictError, resolvePolicies, tenantScopingPolicy } from "../../../src/policies";

describe("policy resolution", () => {
    test("returns an empty list when no policies are provided", () => {
        expect(resolvePolicies()).toEqual([]);
    });

    test("throws when multiple explicit policies share the same name", () => {
        // Explicit composition must be unambiguous because policy order and presence
        // are security-sensitive.
        const first = { name: "allowed-functions" };
        const second = { name: "allowed-functions" };

        expect(() =>
            resolvePolicies({
                policies: [first, second],
            }),
        ).toThrow(PolicyConflictError);
    });

    test("throws when composing multiple tenant scoping policy instances", () => {
        const usersPolicy = tenantScopingPolicy({
            tables: ["users"],
            scopeColumn: "tenant_id",
            contextKey: "tenantId",
        });
        const ordersPolicy = tenantScopingPolicy({
            tables: ["orders"],
            scopeColumn: "workspace_id",
            contextKey: "workspaceId",
        });

        expect(() =>
            resolvePolicies({
                policies: [usersPolicy, ordersPolicy],
            }),
        ).toThrow(PolicyConflictError);
    });
});
