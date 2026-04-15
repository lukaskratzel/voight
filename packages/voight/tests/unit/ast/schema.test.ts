import { describe, expect, test } from "vitest";

import { validateQueryAst } from "../../../src/ast/query-ast-schema";
import { parseQuery } from "../../_support/parse";

describe("query AST schema", () => {
    test("accepts parser-produced query ASTs", () => {
        const result = validateQueryAst(parseQuery("SELECT id FROM users"));

        expect(result.ok).toBe(true);
    });

    test("rejects malformed AST payloads", () => {
        const result = validateQueryAst({
            kind: "Query",
            span: { start: 0, end: 8 },
            body: {
                kind: "SelectStatement",
                span: { start: 0, end: 8 },
                selectItems: [],
            },
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.summary.length).toBeGreaterThan(0);
        }
    });
});
