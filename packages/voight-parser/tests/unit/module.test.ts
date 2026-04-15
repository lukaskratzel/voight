import { beforeAll, describe, expect, it } from "vitest";

import { createVoightParser, type VoightParserModule } from "../../index";

describe("@voight/voight-parser", () => {
    let parser: VoightParserModule;

    beforeAll(async () => {
        parser = await createVoightParser();
    });

    function parseQueryJson(input: string) {
        return JSON.parse(parser.parseQuery(input));
    }

    it("loads the wasm bundle and returns query JSON", () => {
        const result = parseQueryJson("SELECT 1");

        expect(result.kind).toBe("Query");
        expect(result.body.kind).toBe("SelectStatement");
    });

    it("serializes a simple select into the expected JSON tree", () => {
        const result = parseQueryJson(
            "SELECT id, name FROM users WHERE age > 18 ORDER BY created_at DESC LIMIT 10",
        );

        expect(result).toEqual({
            kind: "Query",
            span: { start: 0, end: 75 },
            body: {
                kind: "SelectStatement",
                span: { start: 0, end: 75 },
                distinct: false,
                selectItems: [
                    {
                        kind: "SelectExpressionItem",
                        span: { start: 7, end: 9 },
                        expression: {
                            kind: "IdentifierExpression",
                            span: { start: 7, end: 9 },
                            identifier: {
                                kind: "Identifier",
                                span: { start: 7, end: 9 },
                                name: "id",
                                quoted: false,
                            },
                        },
                    },
                    {
                        kind: "SelectExpressionItem",
                        span: { start: 11, end: 15 },
                        expression: {
                            kind: "IdentifierExpression",
                            span: { start: 11, end: 15 },
                            identifier: {
                                kind: "Identifier",
                                span: { start: 11, end: 15 },
                                name: "name",
                                quoted: false,
                            },
                        },
                    },
                ],
                from: {
                    kind: "TableReference",
                    span: { start: 21, end: 26 },
                    name: {
                        kind: "QualifiedName",
                        span: { start: 21, end: 26 },
                        parts: [
                            {
                                kind: "Identifier",
                                span: { start: 21, end: 26 },
                                name: "users",
                                quoted: false,
                            },
                        ],
                    },
                },
                joins: [],
                whereSpan: { start: 27, end: 41 },
                where: {
                    kind: "BinaryExpression",
                    operator: ">",
                    left: {
                        kind: "IdentifierExpression",
                        span: { start: 33, end: 36 },
                        identifier: {
                            kind: "Identifier",
                            span: { start: 33, end: 36 },
                            name: "age",
                            quoted: false,
                        },
                    },
                    right: {
                        kind: "Literal",
                        span: { start: 39, end: 41 },
                        literalType: "integer",
                        value: "18",
                    },
                    span: { start: 33, end: 41 },
                },
                groupBy: [],
                orderBy: [
                    {
                        kind: "OrderByItem",
                        span: { start: 51, end: 66 },
                        expression: {
                            kind: "IdentifierExpression",
                            span: { start: 51, end: 61 },
                            identifier: {
                                kind: "Identifier",
                                span: { start: 51, end: 61 },
                                name: "created_at",
                                quoted: false,
                            },
                        },
                        direction: "DESC",
                    },
                ],
                limit: {
                    kind: "LimitClause",
                    span: { start: 67, end: 75 },
                    count: {
                        kind: "Literal",
                        span: { start: 73, end: 75 },
                        literalType: "integer",
                        value: "10",
                    },
                },
            },
        });
    });

    it("serializes ctes, joins, subqueries, and offsets through wasm", () => {
        const result = parseQueryJson(
            "WITH recent AS (SELECT user_id FROM orders WHERE status = 'paid') SELECT u.id FROM users u LEFT JOIN recent ON recent.user_id = u.id WHERE u.id IN (SELECT user_id FROM recent) LIMIT 5 OFFSET 2",
        );

        expect(result).toMatchObject({
            kind: "Query",
            with: {
                kind: "WithClause",
                ctes: [
                    {
                        kind: "CommonTableExpression",
                        name: {
                            kind: "Identifier",
                            name: "recent",
                            quoted: false,
                        },
                        columns: [],
                        query: {
                            kind: "Query",
                            body: {
                                kind: "SelectStatement",
                                from: {
                                    kind: "TableReference",
                                    name: {
                                        kind: "QualifiedName",
                                        parts: [{ name: "orders", quoted: false }],
                                    },
                                },
                                where: {
                                    kind: "BinaryExpression",
                                    operator: "=",
                                    right: {
                                        kind: "Literal",
                                        literalType: "string",
                                        value: "paid",
                                    },
                                },
                            },
                        },
                    },
                ],
            },
            body: {
                kind: "SelectStatement",
                from: {
                    kind: "TableReference",
                    alias: { name: "u", quoted: false },
                },
                joins: [
                    {
                        kind: "Join",
                        joinType: "LEFT",
                        table: {
                            kind: "TableReference",
                            name: {
                                kind: "QualifiedName",
                                parts: [{ name: "recent", quoted: false }],
                            },
                        },
                        on: {
                            kind: "BinaryExpression",
                            operator: "=",
                        },
                    },
                ],
                where: {
                    kind: "InSubqueryExpression",
                    negated: false,
                    operand: {
                        kind: "QualifiedReference",
                        qualifier: { name: "u", quoted: false },
                        column: { name: "id", quoted: false },
                    },
                    query: {
                        kind: "Query",
                        body: {
                            kind: "SelectStatement",
                            selectItems: [
                                {
                                    kind: "SelectExpressionItem",
                                    expression: {
                                        kind: "IdentifierExpression",
                                        identifier: { name: "user_id", quoted: false },
                                    },
                                },
                            ],
                        },
                    },
                },
                limit: {
                    kind: "LimitClause",
                    count: {
                        kind: "Literal",
                        literalType: "integer",
                        value: "5",
                    },
                    offset: {
                        kind: "Literal",
                        literalType: "integer",
                        value: "2",
                    },
                },
            },
        });
    });

    it("decodes quoted identifiers correctly in json output", () => {
        const result = parseQueryJson("SELECT `two``part` AS `alias_name` FROM `user-table`");

        expect(result.body.selectItems[0]).toMatchObject({
            kind: "SelectExpressionItem",
            expression: {
                kind: "IdentifierExpression",
                identifier: {
                    kind: "Identifier",
                    name: "two`part",
                    quoted: true,
                },
            },
            alias: {
                kind: "Identifier",
                name: "alias_name",
                quoted: true,
            },
        });

        expect(result.body.from).toMatchObject({
            kind: "TableReference",
            name: {
                kind: "QualifiedName",
                parts: [
                    {
                        kind: "Identifier",
                        name: "user-table",
                        quoted: true,
                    },
                ],
            },
        });
    });

    it("returns syntax failures as structured JSON", () => {
        const result = parseQueryJson("SELECT FROM");

        expect(result.error).toBe(true);
        expect(result.type).toBe("SyntaxError");
        expect(result.message).toContain("mismatched input");
        expect(result.span).toEqual({ start: 7, end: 11 });
    });

    it("fails closed when the wasm bundle is missing", async () => {
        await expect(
            createVoightParser({
                moduleUrl: new URL("./module.test.ts", import.meta.url),
                moduleExists: () => false,
            }),
        ).rejects.toThrow("Voight parser bundle is missing");
    });

    it("fails when the bundle module is missing its default factory", async () => {
        await expect(
            createVoightParser({
                moduleUrl: new URL("./module.test.ts", import.meta.url),
                moduleExists: () => true,
                importModule: async () => ({}),
            }),
        ).rejects.toThrow("default module factory export");
    });

    it("fails when the initialized module does not expose parseQuery", async () => {
        await expect(
            createVoightParser({
                moduleUrl: new URL("./module.test.ts", import.meta.url),
                moduleExists: () => true,
                importModule: async () => ({
                    default: async () => ({}),
                }),
            }),
        ).rejects.toThrow("parseQuery export");
    });
});
