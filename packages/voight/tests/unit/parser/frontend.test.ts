import { describe, expect, test } from "vitest";

import { CompilerStage, DiagnosticCode } from "../../../src/core/diagnostics";
import { parse } from "../../../src/parser";

describe("native frontend", () => {
    test("parses a query wrapper with join, grouping, ordering, and limit", () => {
        const result = parse(
            "SELECT u.id, SUM(o.total) AS total FROM users u INNER JOIN orders o ON u.id = o.user_id WHERE u.tenant_id = ? GROUP BY u.id HAVING SUM(o.total) > 10 ORDER BY total DESC LIMIT 5 OFFSET 2",
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.stage).toBe(CompilerStage.Parser);
        expect(result.value.kind).toBe("Query");
        expect(result.value.body.selectItems).toHaveLength(2);
        expect(result.value.body.joins).toHaveLength(1);
        expect(result.value.body.groupBy).toHaveLength(1);
        expect(result.value.body.orderBy).toHaveLength(1);
        expect(result.value.body.limit?.offset?.kind).toBe("Literal");
    });

    test("parses scalar and IN subqueries", () => {
        const result = parse(
            "SELECT id, (SELECT COUNT(*) FROM orders o WHERE o.user_id = users.id) AS order_count FROM users WHERE id IN (SELECT user_id FROM orders)",
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.body.selectItems[1]?.kind).toBe("SelectExpressionItem");
        if (result.value.body.selectItems[1]?.kind === "SelectExpressionItem") {
            expect(result.value.body.selectItems[1].expression.kind).toBe(
                "ScalarSubqueryExpression",
            );
        }

        expect(result.value.body.where?.kind).toBe("InSubqueryExpression");
    });

    test("parses CTEs, quoted identifiers, interval-unit identifiers, current keywords, and semicolon-terminated selects", () => {
        const cte = parse(
            "WITH recent_orders AS (SELECT user_id FROM orders) SELECT user_id FROM recent_orders",
        );
        expect(cte.ok).toBe(true);
        if (cte.ok) {
            expect(cte.value.with?.ctes[0]?.name.name).toBe("recent_orders");
        }

        const intervalUnitIdentifier = parse(
            "WITH daily AS (SELECT created_at AS day FROM orders) SELECT day FROM daily ORDER BY day",
        );
        expect(intervalUnitIdentifier.ok).toBe(true);
        if (intervalUnitIdentifier.ok) {
            expect(
                intervalUnitIdentifier.value.with?.ctes[0]?.query.body.selectItems[0]?.kind,
            ).toBe("SelectExpressionItem");
        }

        const quoted = parse("SELECT `name` FROM `users` AS `u` ORDER BY `u`.`name` ASC");
        expect(quoted.ok).toBe(true);
        if (quoted.ok) {
            expect(quoted.value.body.from?.alias?.quoted).toBe(true);
            expect(quoted.value.body.orderBy[0]?.direction).toBe("ASC");
        }

        for (const sql of [
            "SELECT now()",
            "SELECT (CURRENT_TIMESTAMP)",
            "SELECT (CURRENT_DATE)",
            "SELECT (CURRENT_TIME)",
            "SELECT CURRENT_TIME",
            "SELECT 1;",
        ]) {
            expect(parse(sql).ok).toBe(true);
        }
    });

    test("parses projection-only selects and wildcard limit syntax", () => {
        const projection = parse("SELECT 1");
        expect(projection.ok).toBe(true);
        if (projection.ok) {
            expect(projection.value.body.from).toBeUndefined();
            expect(projection.value.body.distinct).toBe(false);
            expect(projection.value.body.selectItems).toHaveLength(1);
        }

        const wildcard = parse("SELECT u.*, * FROM users u LIMIT 2, 5");
        expect(wildcard.ok).toBe(true);
        if (wildcard.ok) {
            expect(wildcard.value.body.selectItems[0]?.kind).toBe("SelectWildcardItem");
            expect(wildcard.value.body.selectItems[1]?.kind).toBe("SelectWildcardItem");
            expect(wildcard.value.body.limit?.offset?.kind).toBe("Literal");
            expect(wildcard.value.body.limit?.count.kind).toBe("Literal");
        }
    });

    test("parses CROSS JOIN by normalizing it to an INNER join with a TRUE predicate", () => {
        const parsed = parse("SELECT u.id FROM users AS u CROSS JOIN orders AS o");

        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
            return;
        }

        const join = parsed.value.body.joins[0];
        expect(join?.joinType).toBe("INNER");
        expect(join?.on.kind).toBe("Literal");
        if (join?.on.kind === "Literal") {
            expect(join.on.literalType).toBe("boolean");
            expect(join.on.value).toBe(true);
        }
    });

    test("parses SELECT DISTINCT and COUNT(DISTINCT ...)", () => {
        const selectDistinct = parse("SELECT DISTINCT id FROM users");
        expect(selectDistinct.ok).toBe(true);
        if (selectDistinct.ok) {
            expect(selectDistinct.value.body.distinct).toBe(true);
            const first = selectDistinct.value.body.selectItems[0];
            expect(first?.kind).toBe("SelectExpressionItem");
            if (first?.kind === "SelectExpressionItem") {
                expect(first.expression.kind).toBe("IdentifierExpression");
            }
        }

        const selectDistinctMultiple = parse("SELECT DISTINCT u.id, u.name FROM users u");
        expect(selectDistinctMultiple.ok).toBe(true);
        if (selectDistinctMultiple.ok) {
            expect(selectDistinctMultiple.value.body.distinct).toBe(true);
            expect(selectDistinctMultiple.value.body.selectItems).toHaveLength(2);
            expect(selectDistinctMultiple.value.body.selectItems[0]?.kind).toBe(
                "SelectExpressionItem",
            );
            expect(selectDistinctMultiple.value.body.selectItems[1]?.kind).toBe(
                "SelectExpressionItem",
            );
        }

        const selectDistinctWildcard = parse("SELECT DISTINCT * FROM users");
        expect(selectDistinctWildcard.ok).toBe(true);
        if (selectDistinctWildcard.ok) {
            expect(selectDistinctWildcard.value.body.distinct).toBe(true);
            expect(selectDistinctWildcard.value.body.selectItems[0]?.kind).toBe(
                "SelectWildcardItem",
            );
        }

        const countDistinct = parse("SELECT COUNT(DISTINCT id) FROM users");
        expect(countDistinct.ok).toBe(true);
        if (countDistinct.ok) {
            const first = countDistinct.value.body.selectItems[0];
            expect(first?.kind).toBe("SelectExpressionItem");
            if (
                first?.kind === "SelectExpressionItem" &&
                first.expression.kind === "FunctionCall"
            ) {
                expect(first.expression.callee.name).toBe("COUNT");
                expect(first.expression.distinct).toBe(true);
                expect(first.expression.arguments).toHaveLength(1);
                expect(first.expression.arguments[0]?.kind).toBe("IdentifierExpression");
            }
        }

        const qualifiedCountDistinct = parse("SELECT COUNT(DISTINCT users.id) FROM users");
        expect(qualifiedCountDistinct.ok).toBe(true);
        if (qualifiedCountDistinct.ok) {
            const first = qualifiedCountDistinct.value.body.selectItems[0];
            expect(first?.kind).toBe("SelectExpressionItem");
            if (
                first?.kind === "SelectExpressionItem" &&
                first.expression.kind === "FunctionCall"
            ) {
                expect(first.expression.distinct).toBe(true);
                expect(first.expression.arguments[0]?.kind).toBe("QualifiedReference");
            }
        }
    });

    test("parses CAST and both CASE expression forms", () => {
        const cast = parse("SELECT CAST(age AS DECIMAL(10, 2)) FROM users");
        expect(cast.ok).toBe(true);
        if (cast.ok && cast.value.body.selectItems[0]?.kind === "SelectExpressionItem") {
            const expression = cast.value.body.selectItems[0].expression;
            expect(expression.kind).toBe("CastExpression");
            if (expression.kind === "CastExpression") {
                expect(expression.targetType.name.parts.map((part) => part.name)).toEqual([
                    "DECIMAL",
                ]);
                expect(expression.targetType.arguments).toHaveLength(2);
            }
        }

        const searched = parse(
            "SELECT CASE WHEN age > 18 THEN 'adult' ELSE 'minor' END FROM users",
        );
        expect(searched.ok).toBe(true);
        if (searched.ok && searched.value.body.selectItems[0]?.kind === "SelectExpressionItem") {
            const expression = searched.value.body.selectItems[0].expression;
            expect(expression.kind).toBe("CaseExpression");
            if (expression.kind === "CaseExpression") {
                expect(expression.operand).toBeUndefined();
                expect(expression.whenClauses).toHaveLength(1);
                expect(expression.elseExpression?.kind).toBe("Literal");
            }
        }

        const simple = parse(
            "SELECT CASE status WHEN 'paid' THEN 1 WHEN 'shipped' THEN 2 ELSE 0 END FROM orders",
        );
        expect(simple.ok).toBe(true);
        if (simple.ok && simple.value.body.selectItems[0]?.kind === "SelectExpressionItem") {
            const expression = simple.value.body.selectItems[0].expression;
            expect(expression.kind).toBe("CaseExpression");
            if (expression.kind === "CaseExpression") {
                expect(expression.operand?.kind).toBe("IdentifierExpression");
                expect(expression.whenClauses).toHaveLength(2);
            }
        }
    });

    test("parses INTERVAL expressions inside MySQL date arithmetic functions", () => {
        const parsed = parse(
            "SELECT DATE_ADD('2026-04-08', INTERVAL 1 DAY), DATE_SUB('2026-04-08', INTERVAL ? MONTH)",
        );

        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
            return;
        }

        const first = parsed.value.body.selectItems[0];
        expect(first?.kind).toBe("SelectExpressionItem");
        if (first?.kind === "SelectExpressionItem" && first.expression.kind === "FunctionCall") {
            expect(first.expression.callee.name).toBe("DATE_ADD");
            expect(first.expression.arguments[1]?.kind).toBe("IntervalExpression");
            if (first.expression.arguments[1]?.kind === "IntervalExpression") {
                expect(first.expression.arguments[1].unit).toBe("DAY");
                expect(first.expression.arguments[1].value.kind).toBe("Literal");
            }
        }

        const second = parsed.value.body.selectItems[1];
        expect(second?.kind).toBe("SelectExpressionItem");
        if (second?.kind === "SelectExpressionItem" && second.expression.kind === "FunctionCall") {
            expect(second.expression.callee.name).toBe("DATE_SUB");
            expect(second.expression.arguments[1]?.kind).toBe("IntervalExpression");
            if (second.expression.arguments[1]?.kind === "IntervalExpression") {
                expect(second.expression.arguments[1].unit).toBe("MONTH");
                expect(second.expression.arguments[1].value.kind).toBe("Parameter");
            }
        }
    });

    test("parses window functions with OVER, PARTITION BY, and ORDER BY", () => {
        const parsed = parse(
            "SELECT SUM(total) OVER (PARTITION BY user_id ORDER BY created_at DESC) AS running_total, COUNT(*) OVER () AS total_rows FROM orders",
        );

        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
            return;
        }

        const first = parsed.value.body.selectItems[0];
        expect(first?.kind).toBe("SelectExpressionItem");
        if (first?.kind === "SelectExpressionItem" && first.expression.kind === "FunctionCall") {
            expect(first.expression.callee.name).toBe("SUM");
            expect(first.expression.over?.partitionBy).toHaveLength(1);
            expect(first.expression.over?.partitionBy[0]?.kind).toBe("IdentifierExpression");
            expect(first.expression.over?.orderBy).toHaveLength(1);
            expect(first.expression.over?.orderBy[0]?.direction).toBe("DESC");
        }

        const second = parsed.value.body.selectItems[1];
        expect(second?.kind).toBe("SelectExpressionItem");
        if (second?.kind === "SelectExpressionItem" && second.expression.kind === "FunctionCall") {
            expect(second.expression.callee.name).toBe("COUNT");
            expect(second.expression.over?.partitionBy).toEqual([]);
            expect(second.expression.over?.orderBy).toEqual([]);
        }
    });

    test("parses LIKE predicates as binary expressions", () => {
        const result = parse("SELECT id FROM users WHERE name LIKE 'adm%n'");

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.body.where?.kind).toBe("BinaryExpression");
        if (result.value.body.where?.kind === "BinaryExpression") {
            expect(result.value.body.where.operator).toBe("LIKE");
            expect(result.value.body.where.left.kind).toBe("IdentifierExpression");
            expect(result.value.body.where.right.kind).toBe("Literal");
        }
    });

    test("reports unsupported statements", () => {
        const result = parse("UPDATE users SET name = 'x'");

        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.stage).toBe(CompilerStage.Parser);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnsupportedStatement);
    });

    test("reports comment rejection and truncated input diagnostics", () => {
        const comment = parse("SELECT 1 -- comment");
        expect(comment.ok).toBe(false);
        if (!comment.ok) {
            expect(comment.diagnostics[0]?.code).toBe(DiagnosticCode.UnsupportedComment);
        }

        const truncated = parse("SELECT id FROM");
        expect(truncated.ok).toBe(false);
        if (!truncated.ok) {
            expect(truncated.diagnostics[0]?.code).toBe(DiagnosticCode.UnexpectedEndOfInput);
        }
    });

    test("reports malformed strings, quoted identifiers, and stray characters", () => {
        const cases = [
            ["SELECT 'oops", DiagnosticCode.UnexpectedToken],
            ["SELECT `users FROM users", DiagnosticCode.UnexpectedToken],
            ["SELECT `` FROM users", DiagnosticCode.InvalidIdentifier],
            ["SELECT `café` FROM users", DiagnosticCode.InvalidIdentifier],
            ["SELECT `line1\nline2` FROM users", DiagnosticCode.InvalidIdentifier],
            ["SELECT id FROM users @", DiagnosticCode.UnexpectedToken],
            ["SELECT 1; SELECT 2", DiagnosticCode.UnexpectedToken],
        ] as const;

        for (const [sql, expectedCode] of cases) {
            const result = parse(sql);
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.diagnostics[0]?.code).toBe(expectedCode);
            }
        }
    });

    test("rejects queries containing source-level null bytes before entering WASM", () => {
        const result = parse("SELECT id FROM users\0");

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnexpectedCharacter);
        }
    });
});
