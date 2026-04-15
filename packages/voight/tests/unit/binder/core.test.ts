import { describe, expect, test } from "vitest";

import { bind } from "../../../src/binder";
import { createTableSchema, InMemoryCatalog } from "../../../src/catalog";
import { DiagnosticCode } from "../../../src/core/diagnostics";
import { createTestCatalog } from "../../../src/testing";
import { parseQuery } from "../../_support/parse";

describe("bind", () => {
    test("binds tables and columns against the catalog", () => {
        const ast = parseQuery(
            "SELECT u.id, o.total FROM users u INNER JOIN orders o ON u.id = o.user_id WHERE u.tenant_id = ?",
        );

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.body.scope.tables.size).toBe(2);
        expect(result.value.body.selectItems[0]?.kind).toBe("BoundSelectExpressionItem");
    });

    test("binds CTEs and correlated subqueries", () => {
        const ast = parseQuery(
            "WITH recent_orders AS (SELECT user_id FROM orders) SELECT id FROM users WHERE EXISTS (SELECT 1 FROM recent_orders r WHERE r.user_id = users.id)",
        );

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.with?.ctes).toHaveLength(1);
        expect(result.value.body.where?.kind).toBe("BoundExistsExpression");
    });

    test("fails for unknown tables", () => {
        const ast = parseQuery("SELECT id FROM missing");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownTable);
    });

    test("fails for ambiguous columns", () => {
        const ast = parseQuery("SELECT id FROM users u INNER JOIN orders o ON u.id = o.user_id");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.AmbiguousColumn);
    });

    test("fails for duplicate table aliases", () => {
        const ast = parseQuery("SELECT u.id FROM users u INNER JOIN orders u ON u.id = u.user_id");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.DuplicateAlias);
    });

    test("fails for unknown qualified columns", () => {
        const ast = parseQuery("SELECT u.missing FROM users u");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownColumn);
    });

    test("fails for unknown aliases in qualified wildcard", () => {
        const ast = parseQuery("SELECT x.* FROM users u");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownTable);
    });

    test("binds unqualified wildcard across known tables", () => {
        const ast = parseQuery("SELECT * FROM users u");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.body.selectItems[0]?.kind).toBe("BoundSelectWildcardItem");
        if (result.value.body.selectItems[0]?.kind === "BoundSelectWildcardItem") {
            expect(result.value.body.selectItems[0].columns.length).toBeGreaterThan(0);
        }
    });

    test("filters non-selectable columns out of wildcards", () => {
        const ast = parseQuery("SELECT * FROM users");
        const catalog = new InMemoryCatalog([
            createTableSchema({
                path: ["users"],
                columns: ["id", "name", { name: "tenant_id", selectable: false }],
            }),
        ]);

        const result = bind(ast, catalog);
        expect(result.ok).toBe(true);
        if (!result.ok || result.value.body.selectItems[0]?.kind !== "BoundSelectWildcardItem") {
            return;
        }

        expect(result.value.body.selectItems[0].columns.map((column) => column.name)).toEqual([
            "id",
            "name",
        ]);
    });

    test("rejects direct projection of a non-selectable column", () => {
        const ast = parseQuery("SELECT tenant_id FROM users");
        const catalog = new InMemoryCatalog([
            createTableSchema({
                path: ["users"],
                columns: ["id", { name: "tenant_id", selectable: false }],
            }),
        ]);

        const result = bind(ast, catalog);
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
    });

    test("rejects expression projection that references a non-selectable column", () => {
        const ast = parseQuery("SELECT COALESCE(tenant_id, 'missing') FROM users");
        const catalog = new InMemoryCatalog([
            createTableSchema({
                path: ["users"],
                columns: ["id", { name: "tenant_id", selectable: false }],
            }),
        ]);

        const result = bind(ast, catalog);
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
    });

    test("rejects non-selectable columns inside CAST and CASE expressions", () => {
        const catalog = new InMemoryCatalog([
            createTableSchema({
                path: ["users"],
                columns: ["id", { name: "tenant_id", selectable: false }],
            }),
        ]);

        const castResult = bind(
            parseQuery("SELECT CAST(tenant_id AS CHAR(36)) FROM users"),
            catalog,
        );
        expect(castResult.ok).toBe(false);
        if (!castResult.ok) {
            expect(castResult.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
        }

        const caseResult = bind(
            parseQuery("SELECT CASE WHEN tenant_id IS NULL THEN 'x' ELSE 'y' END FROM users"),
            catalog,
        );
        expect(caseResult.ok).toBe(false);
        if (!caseResult.ok) {
            expect(caseResult.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
        }
    });

    test("rejects non-selectable columns inside INTERVAL expressions", () => {
        const catalog = new InMemoryCatalog([
            createTableSchema({
                path: ["users"],
                columns: ["id", { name: "tenant_id", selectable: false }],
            }),
        ]);

        const result = bind(
            parseQuery("SELECT DATE_ADD('2026-04-08', INTERVAL tenant_id DAY) FROM users"),
            catalog,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
        }
    });

    test("rejects wildcards when a table exposes no selectable columns", () => {
        const ast = parseQuery("SELECT users.* FROM users");
        const catalog = new InMemoryCatalog([
            createTableSchema({
                path: ["users"],
                columns: [{ name: "tenant_id", selectable: false }],
            }),
        ]);

        const result = bind(ast, catalog);
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
    });

    test("allows COUNT(*) as a special wildcard aggregate", () => {
        const ast = parseQuery("SELECT COUNT(*) FROM users");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        const selectItem = result.value.body.selectItems[0];
        expect(selectItem?.kind).toBe("BoundSelectExpressionItem");
        if (selectItem?.kind === "BoundSelectExpressionItem") {
            expect(selectItem.expression.kind).toBe("BoundFunctionCall");
        }
    });

    test("binds SELECT DISTINCT and COUNT(DISTINCT ...)", () => {
        const ast = parseQuery("SELECT DISTINCT COUNT(DISTINCT id) FROM users");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.body.distinct).toBe(true);
        const selectItem = result.value.body.selectItems[0];
        expect(selectItem?.kind).toBe("BoundSelectExpressionItem");
        if (selectItem?.kind === "BoundSelectExpressionItem") {
            expect(selectItem.expression.kind).toBe("BoundFunctionCall");
            if (selectItem.expression.kind === "BoundFunctionCall") {
                expect(selectItem.expression.distinct).toBe(true);
            }
        }
    });

    test("binds SELECT DISTINCT projections without misparsing DISTINCT as an identifier", () => {
        const ast = parseQuery("SELECT DISTINCT id FROM users");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.body.distinct).toBe(true);
        expect(result.value.output.map((column) => column.name)).toEqual(["id"]);
        const selectItem = result.value.body.selectItems[0];
        expect(selectItem?.kind).toBe("BoundSelectExpressionItem");
        if (selectItem?.kind === "BoundSelectExpressionItem") {
            expect(selectItem.expression.kind).toBe("BoundColumnReference");
        }
    });

    test("binds COUNT(DISTINCT qualified_column)", () => {
        const ast = parseQuery("SELECT COUNT(DISTINCT users.id) FROM users");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        const selectItem = result.value.body.selectItems[0];
        expect(selectItem?.kind).toBe("BoundSelectExpressionItem");
        if (selectItem?.kind === "BoundSelectExpressionItem") {
            expect(selectItem.expression.kind).toBe("BoundFunctionCall");
            if (selectItem.expression.kind === "BoundFunctionCall") {
                expect(selectItem.expression.distinct).toBe(true);
                expect(selectItem.expression.arguments[0]?.kind).toBe("BoundColumnReference");
            }
        }
    });

    test("rejects qualified wildcard arguments inside COUNT", () => {
        const ast = parseQuery("SELECT COUNT(u.*) FROM users AS u");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnsupportedConstruct);
    });

    test("rejects DISTINCT wildcard arguments inside COUNT", () => {
        const ast = parseQuery("SELECT COUNT(DISTINCT *) FROM users");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnsupportedConstruct);
    });

    test("rejects DISTINCT qualified wildcard arguments inside COUNT", () => {
        const ast = parseQuery("SELECT COUNT(DISTINCT u.*) FROM users AS u");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnsupportedConstruct);
    });

    test("rejects wildcard arguments for non-COUNT functions", () => {
        const ast = parseQuery("SELECT SUM(*) FROM users");

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnsupportedConstruct);
    });

    test("binds window functions and window specifications", () => {
        const ast = parseQuery(
            "SELECT SUM(total) OVER (PARTITION BY user_id ORDER BY created_at DESC) FROM orders",
        );

        const result = bind(ast, createTestCatalog());
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        const selectItem = result.value.body.selectItems[0];
        expect(selectItem?.kind).toBe("BoundSelectExpressionItem");
        if (selectItem?.kind === "BoundSelectExpressionItem") {
            expect(selectItem.expression.kind).toBe("BoundFunctionCall");
            if (selectItem.expression.kind === "BoundFunctionCall") {
                expect(selectItem.expression.over?.partitionBy).toHaveLength(1);
                expect(selectItem.expression.over?.orderBy).toHaveLength(1);
            }
        }
    });

    test("rejects non-selectable columns inside window PARTITION BY", () => {
        const ast = parseQuery("SELECT COUNT(*) OVER (PARTITION BY tenant_id) FROM users");
        const catalog = new InMemoryCatalog([
            createTableSchema({
                path: ["users"],
                columns: ["id", { name: "tenant_id", selectable: false }],
            }),
        ]);

        const result = bind(ast, catalog);
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
    });

    test("rejects non-selectable columns inside window ORDER BY", () => {
        const ast = parseQuery("SELECT COUNT(*) OVER (ORDER BY tenant_id DESC) FROM users");
        const catalog = new InMemoryCatalog([
            createTableSchema({
                path: ["users"],
                columns: ["id", { name: "tenant_id", selectable: false }],
            }),
        ]);

        const result = bind(ast, catalog);
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
    });
});
