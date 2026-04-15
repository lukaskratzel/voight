import { describe, expect, test } from "vitest";

import { InMemoryCatalog, createTableSchema } from "../../../src/catalog";
import { compile } from "../../../src/compiler";
import { rewrite } from "../../../src/compiler/rewriter";
import { DiagnosticCode } from "../../../src/core/diagnostics";
import { createTestCatalog } from "../../../src/testing";
import { parseQuery } from "../../_support/parse";

describe("rewrite", () => {
    test("applies policy rewriters before custom rewriters and records metadata", () => {
        const calls: string[] = [];
        // Policy rewrites need to run first so custom rewriters see the secured shape,
        // and the metadata should accurately report how many transforms ran.
        const result = rewrite(parseQuery("SELECT 1"), {
            policies: [
                {
                    name: "policy-rewriter",
                    rewrite: (query) => {
                        calls.push("policy");
                        return query;
                    },
                },
            ],
            rewriters: [
                {
                    name: "custom-rewriter",
                    rewrite: (query) => {
                        calls.push("custom");
                        return query;
                    },
                },
            ],
        });

        expect(result.ok).toBe(true);
        expect(calls).toEqual(["policy", "custom"]);
        expect(result.meta).toEqual({ appliedRewriters: 2, changed: false });
    });

    test("marks the query as changed when a rewriter returns a new AST object", () => {
        const query = parseQuery("SELECT 1");
        // The changed flag is identity-based today. This test locks in that contract so
        // callers can tell whether a rewrite produced a new tree.
        const result = rewrite(query, {
            rewriters: [
                {
                    rewrite: (current) => ({
                        ...current,
                    }),
                },
            ],
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.meta.changed).toBe(true);
            expect(result.value).not.toBe(query);
        }
    });

    test("surfaces rewrite exceptions as invariant violations", () => {
        // Rewriters are privileged code. If one throws, the compiler should fail closed
        // with a rewrite-stage diagnostic instead of leaking a raw exception.
        const result = rewrite(parseQuery("SELECT 1"), {
            rewriters: [
                {
                    rewrite: () => {
                        throw new Error("boom");
                    },
                },
            ],
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.RewriteInvariantViolation);
            expect(result.diagnostics[0]?.message).toContain("boom");
        }
    });

    test("rejects invalid AST shapes returned by rewriters", () => {
        const result = rewrite(parseQuery("SELECT 1"), {
            rewriters: [
                {
                    rewrite: () =>
                        ({
                            kind: "Query",
                            span: { start: 0, end: 8 },
                            body: {},
                        }) as never,
                },
            ],
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.RewriteInvariantViolation);
            expect(result.diagnostics[0]?.message).toContain("invalid AST");
        }
    });

    test("rejects raw SQL in rewritten binary operators", () => {
        const result = compile("SELECT id FROM users", {
            catalog: createTestCatalog(),
            rewriters: [
                {
                    rewrite: (query) => ({
                        ...query,
                        body: {
                            ...query.body,
                            where: {
                                kind: "BinaryExpression",
                                span: query.body.span,
                                operator: "= 1 OR 1=1 --" as never,
                                left: {
                                    kind: "IdentifierExpression",
                                    span: query.body.span,
                                    identifier: {
                                        kind: "Identifier",
                                        span: query.body.span,
                                        name: "id",
                                        quoted: false,
                                    },
                                },
                                right: {
                                    kind: "Literal",
                                    span: query.body.span,
                                    literalType: "integer",
                                    value: "1",
                                },
                            },
                        },
                    }),
                },
            ],
            debug: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.terminalStage).toBe("rewriter");
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.RewriteInvariantViolation);
        }
    });

    test("rejects raw SQL in rewritten numeric literals", () => {
        const result = compile("SELECT id FROM users", {
            catalog: createTestCatalog(),
            rewriters: [
                {
                    rewrite: (query) => ({
                        ...query,
                        body: {
                            ...query.body,
                            where: {
                                kind: "BinaryExpression",
                                span: query.body.span,
                                operator: "=",
                                left: {
                                    kind: "IdentifierExpression",
                                    span: query.body.span,
                                    identifier: {
                                        kind: "Identifier",
                                        span: query.body.span,
                                        name: "id",
                                        quoted: false,
                                    },
                                },
                                right: {
                                    kind: "Literal",
                                    span: query.body.span,
                                    literalType: "integer",
                                    value: "0 OR 1=1 --",
                                },
                            },
                        },
                    }),
                },
            ],
            debug: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.terminalStage).toBe("rewriter");
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.RewriteInvariantViolation);
        }
    });

    test("rejects raw SQL in rewritten ORDER BY directions", () => {
        const result = compile("SELECT id FROM users", {
            catalog: createTestCatalog(),
            rewriters: [
                {
                    rewrite: (query) => ({
                        ...query,
                        body: {
                            ...query.body,
                            orderBy: [
                                {
                                    kind: "OrderByItem",
                                    span: query.body.span,
                                    direction: "DESC NULLS LAST, (SELECT 1)--" as never,
                                    expression: {
                                        kind: "IdentifierExpression",
                                        span: query.body.span,
                                        identifier: {
                                            kind: "Identifier",
                                            span: query.body.span,
                                            name: "id",
                                            quoted: false,
                                        },
                                    },
                                },
                            ],
                        },
                    }),
                },
            ],
            debug: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.terminalStage).toBe("rewriter");
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.RewriteInvariantViolation);
        }
    });

    test("rejects raw SQL in rewritten CURRENT_* expressions", () => {
        const result = compile("SELECT id FROM users", {
            catalog: createTestCatalog(),
            rewriters: [
                {
                    rewrite: (query) => ({
                        ...query,
                        body: {
                            ...query.body,
                            selectItems: [
                                {
                                    kind: "SelectExpressionItem",
                                    span: query.body.span,
                                    expression: {
                                        kind: "CurrentKeywordExpression",
                                        span: query.body.span,
                                        keyword: "CURRENT_TIMESTAMP) OR 1=1 --" as never,
                                    },
                                },
                            ],
                        },
                    }),
                },
            ],
            debug: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.terminalStage).toBe("rewriter");
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.RewriteInvariantViolation);
        }
    });

    test("rejects raw SQL in rewritten join types", () => {
        const result = compile("SELECT users.id FROM users", {
            catalog: createTestCatalog(),
            rewriters: [
                {
                    rewrite: (query) => ({
                        ...query,
                        body: {
                            ...query.body,
                            joins: [
                                {
                                    kind: "Join",
                                    span: query.body.span,
                                    joinType: "INNER JOIN `users` AS `evil` ON 1=1 --" as never,
                                    table: {
                                        kind: "TableReference",
                                        span: query.body.span,
                                        name: {
                                            kind: "QualifiedName",
                                            span: query.body.span,
                                            parts: [
                                                {
                                                    kind: "Identifier",
                                                    span: query.body.span,
                                                    name: "orders",
                                                    quoted: false,
                                                },
                                            ],
                                        },
                                        alias: {
                                            kind: "Identifier",
                                            span: query.body.span,
                                            name: "o",
                                            quoted: false,
                                        },
                                    },
                                    on: {
                                        kind: "BinaryExpression",
                                        span: query.body.span,
                                        operator: "=",
                                        left: {
                                            kind: "Literal",
                                            span: query.body.span,
                                            literalType: "integer",
                                            value: "1",
                                        },
                                        right: {
                                            kind: "Literal",
                                            span: query.body.span,
                                            literalType: "integer",
                                            value: "1",
                                        },
                                    },
                                },
                            ],
                        },
                    }),
                },
            ],
            debug: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.terminalStage).toBe("rewriter");
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.RewriteInvariantViolation);
        }
    });

    test("does not trust forged hidden-column markers from hostile rewriters", () => {
        const catalog = new InMemoryCatalog([
            createTableSchema({
                path: ["users"],
                columns: ["id", { name: "tenant_id", selectable: false }],
            }),
        ]);

        const result = compile("SELECT id FROM users", {
            catalog,
            rewriters: [
                {
                    rewrite: (query) => ({
                        ...query,
                        body: {
                            ...query.body,
                            where: {
                                kind: "BinaryExpression",
                                span: query.body.span,
                                operator: "=",
                                left: {
                                    kind: "IdentifierExpression",
                                    span: query.body.span,
                                    identifier: {
                                        kind: "Identifier",
                                        span: query.body.span,
                                        name: "tenant_id",
                                        quoted: false,
                                        trusted: true as never,
                                    },
                                },
                                right: {
                                    kind: "Literal",
                                    span: query.body.span,
                                    literalType: "string",
                                    value: "tenant-123",
                                },
                            },
                        },
                    }),
                },
            ],
            debug: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.terminalStage).toBe("binder");
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
        }
    });
});
