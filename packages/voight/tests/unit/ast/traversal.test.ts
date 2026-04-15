import { describe, expect, test } from "vitest";

import { collectBoundPolicyDiagnostics } from "../../../src/ast/bound-policy-traversal";
import { visitBoundQuery } from "../../../src/ast/bound-traversal";
import { mapQueryAst } from "../../../src/ast/query-ast-traversal";
import { CompilerStage, DiagnosticCode, createDiagnostic } from "../../../src/core/diagnostics";
import { createSpan } from "../../../src/core/source";
import { bindStatement } from "../../_support/bind";
import { parseQuery } from "../../_support/parse";

describe("AST traversal helpers", () => {
    test("visits bound queries, tables, and expressions through nested subqueries", () => {
        const bound = bindStatement(
            "WITH recent_orders AS (SELECT user_id FROM orders) SELECT id FROM users WHERE EXISTS (SELECT 1 FROM recent_orders WHERE recent_orders.user_id = users.id)",
        );
        const visited = {
            queries: 0,
            selects: 0,
            tables: [] as string[],
            expressions: 0,
        };

        visitBoundQuery(bound, {
            query: () => {
                visited.queries += 1;
            },
            select: () => {
                visited.selects += 1;
            },
            table: (table) => {
                visited.tables.push(table.alias);
            },
            expression: () => {
                visited.expressions += 1;
            },
        });

        expect(visited.queries).toBeGreaterThanOrEqual(3);
        expect(visited.selects).toBeGreaterThanOrEqual(3);
        expect(visited.tables).toContain("users");
        expect(visited.tables).toContain("recent_orders");
        expect(visited.tables).toContain("orders");
        expect(visited.expressions).toBeGreaterThan(0);
    });

    test("collects select, expression, and finish diagnostics in one pass", () => {
        const bound = bindStatement("SELECT id FROM users WHERE age > 18");
        const diagnostics = collectBoundPolicyDiagnostics(bound, {
            select: (select) => [
                createDiagnostic({
                    code: DiagnosticCode.PolicyViolation,
                    stage: CompilerStage.Enforcer,
                    message: "select diagnostic",
                    primarySpan: select.span,
                }),
            ],
            expression: (expression) =>
                expression.kind === "BoundColumnReference"
                    ? [
                          createDiagnostic({
                              code: DiagnosticCode.PolicyViolation,
                              stage: CompilerStage.Enforcer,
                              message: "expression diagnostic",
                              primarySpan: expression.span,
                          }),
                      ]
                    : undefined,
            finish: (query) => [
                createDiagnostic({
                    code: DiagnosticCode.PolicyViolation,
                    stage: CompilerStage.Enforcer,
                    message: "finish diagnostic",
                    primarySpan: query.span,
                }),
            ],
        });

        expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain("select diagnostic");
        expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
            "expression diagnostic",
        );
        expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain("finish diagnostic");
    });

    test("maps nested query AST selects recursively", () => {
        const query = parseQuery(
            "SELECT id FROM users WHERE EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id)",
        );
        let rewrites = 0;

        const mapped = mapQueryAst(query, (select) => {
            rewrites += 1;
            return {
                ...select,
                span: createSpan(select.span.start, select.span.end),
            };
        });

        expect(rewrites).toBeGreaterThanOrEqual(2);
        expect(mapped.kind).toBe("Query");
        expect(mapped.body.where?.kind).toBe("ExistsExpression");
    });
});
