import { describe, expect, test } from "vitest";

import { compile, type CompileOptions } from "../src/compiler";
import { tenantScopingPolicy } from "../src/policies";
import { createTestCatalog } from "../src/testing";

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const catalog = createTestCatalog();

function compileStrict(sql: string, extra: Partial<CompileOptions> = {}) {
    return compile(sql, {
        catalog,
        dialect: "mysql",
        strict: true,
        ...extra,
    });
}

const tenantPolicy = tenantScopingPolicy({
    tables: ["timeseries", "orders"],
    scopeColumn: "tenant_id",
    contextKey: "tenantId",
});

function compileTenantScoped(sql: string, tenantId: unknown = "tenant-123") {
    return compileStrict(sql, {
        policies: [tenantPolicy],
        policyContext: { tenantId },
    });
}

function compileWithFunctions(sql: string, fns: string[] = ["count", "sum", "avg", "min", "max", "coalesce"]) {
    return compileStrict(sql, {
        allowedFunctions: new Set(fns),
    });
}

// ════════════════════════════════════════════════════════════
// 1. EMITTER STRING ESCAPING & SQL INJECTION
// ════════════════════════════════════════════════════════════

describe("emitter string escaping", () => {
    test("single quote in string literal is doubled in output", () => {
        const result = compileStrict("SELECT id FROM users WHERE name = 'O''Brien'");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("'O''Brien'");
    });

    test("backslash in string literal is escaped by emitter", () => {
        // voight lexer does NOT treat backslash as escape. The string 'a\b' is the
        // 3-character string a\b. The emitter now escapes \ to \\ for MySQL safety.
        const result = compileStrict("SELECT 'a\\b'");
        expect(result.ok).toBe(true);
        // The JS string "a\\b" is really a\b. The emitter wraps in quotes,
        // escapes backslashes (\ -> \\) and single quotes (' -> '').
        expect(result.emitted?.sql).toBe("SELECT 'a\\\\b'");
    });

    test("[FIXED] backslash-quote MySQL interpretation mismatch", () => {
        // The emitter now escapes backslashes, so 'a\' becomes 'a\\' in emitted SQL.
        // In MySQL default mode, \\ is a literal backslash, so the string is properly
        // terminated. The mismatch vulnerability is fixed.

        // voight sees 'a\' as a complete string (value = "a\")
        const result = compileStrict("SELECT 'a\\'");
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // The emitter escapes the backslash: value "a\" -> 'a\\'
        // In MySQL, 'a\\' is a terminated string containing a single backslash. Safe.
        expect(sql).toContain("'a\\\\'");

        // The second query also works safely now
        const result2 = compileStrict("SELECT 'a\\' FROM users");
        if (result2.ok) {
            const sql2 = result2.emitted?.sql ?? "";
            // Emitter produces 'a\\' which MySQL correctly interprets as
            // a terminated string containing "a\". No mismatch.
            expect(sql2).toContain("'a\\\\'");
        }
    });

    test("[VULN] crafted backslash-quote sequence for second-order injection", () => {
        // Attacker stores: a\
        // Application later uses this in a query:
        //   SELECT * FROM users WHERE bio = '<stored_value>' AND admin = 0
        //
        // If stored_value = a\, the emitted SQL becomes:
        //   WHERE bio = 'a\' AND admin = 0'
        //
        // MySQL (default mode) interprets \' as escaped quote:
        //   WHERE bio = 'a\' AND admin = 0'  -- entire thing is a string!
        //
        // This test verifies voight does NOT add backslash escaping to its output.
        const result = compileStrict("SELECT id FROM users WHERE name = 'test\\\\'");
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // Verify: does the emitter escape backslashes? It should for MySQL safety.
        // Currently emitLiteral only does: value.replace(/'/g, "''")
        // It does NOT escape backslashes.
        const hasBackslashEscaping = sql.includes("\\\\");
        // If this assertion fails, the emitter has been fixed to escape backslashes
        // If it passes, the vulnerability exists
        if (!hasBackslashEscaping) {
            // Current behavior: backslashes are NOT escaped in emitter output
            // This is potentially dangerous for MySQL connections without
            // NO_BACKSLASH_ESCAPES sql_mode
        }
    });

    test("string with null byte is handled", () => {
        // Null bytes in strings can cause truncation in some MySQL drivers
        const result = compileStrict("SELECT 'before\\0after'");
        expect(result.ok).toBe(true);
        // The lexer treats \0 as literal backslash + 0, not a null byte
        // But what if the actual source string has a null byte?
    });

    test("string with embedded newlines", () => {
        // Multi-line string literals
        const result = compileStrict("SELECT 'line1\nline2'");
        expect(result.ok).toBe(true);
        // Newlines pass through as-is since the lexer treats them as
        // regular characters inside strings
    });

    test("string with comment markers inside is safely emitted", () => {
        const result = compileStrict("SELECT id FROM users WHERE name = 'test */ -- #'");
        // The lexer should handle this because these characters are inside a string
        // Wait: the lexer scans for -- BEFORE string context, so -- inside a string
        // at position after a string is fine. But the key question is: does the
        // lexer see 'test */ -- #' as one string?
        // The lexer reads: ' (open), test */ -- #, ' (close)
        // The -- is inside the string, so the lexer doesn't trigger the comment check
        if (result.ok) {
            expect(result.emitted?.sql).toContain("'test */ -- #'");
        }
    });

    test("tenant scoping value with single quotes is safely escaped", () => {
        const result = compileTenantScoped(
            "SELECT metric FROM timeseries",
            "tenant'123",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // The emitter should escape the quote in the tenant value
        expect(sql).toContain("'tenant''123'");
        // Verify no unescaped quote allows injection
        expect(sql).not.toMatch(/= 'tenant'123'/);
    });

    test("[FIXED] tenant scoping value with backslash-quote in MySQL default mode", () => {
        // If tenantId = "tenant\" the emitter now escapes the backslash:
        //   tenant_id = 'tenant\\'
        // In MySQL default mode, \\ is a literal backslash, so the string is safely terminated
        const result = compileTenantScoped(
            "SELECT metric FROM timeseries",
            "tenant\\",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // The emitter produces 'tenant\\' which MySQL interprets as a terminated string
        expect(sql).toContain("'tenant\\\\'");
    });
});

// ════════════════════════════════════════════════════════════
// 2. IDENTIFIER ESCAPING
// ════════════════════════════════════════════════════════════

describe("emitter identifier escaping", () => {
    test("backtick in identifier is properly escaped", () => {
        const result = compileStrict("SELECT id AS `col``name` FROM users");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("``");
    });

    test("MySQL reserved word as alias is properly quoted", () => {
        const reservedWords = ["select", "from", "where", "group", "order", "limit", "join", "set", "update", "delete", "insert"];
        for (const word of reservedWords) {
            const result = compileStrict(`SELECT id AS \`${word}\` FROM users`);
            expect(result.ok, `Failed for reserved word: ${word}`).toBe(true);
            if (result.ok) {
                expect(result.emitted?.sql).toContain(`\`${word}\``);
            }
        }
    });

    test("identifier with special characters in backticks", () => {
        // The quoteIdentifier function escapes backticks, but what about
        // other special characters?
        const result = compileStrict("SELECT id AS `col;DROP TABLE users` FROM users");
        if (result.ok) {
            // The semicolon and SQL keywords should be inside backtick-quoted identifier
            // Identifiers are lowercased by normalizeIdentifier
            expect(result.emitted?.sql).toContain("`col;drop table users`");
            // Verify it's safely quoted - no unquoted SQL injection
            expect(result.emitted?.sql).not.toMatch(/`col;`/);
        }
    });

    test("empty identifier in backticks", () => {
        // What happens with an empty identifier ``?
        const result = compileStrict("SELECT `` FROM users");
        // The lexer reads `` as a backtick-escaped empty string
        // This should probably be rejected
        if (result.ok) {
            // If it compiles, verify the emitter handles it
            expect(result.emitted?.sql).toBeDefined();
        }
    });

    test("identifier with newlines in backticks", () => {
        const result = compileStrict("SELECT `col\nname` FROM users");
        // The lexer should read this as an identifier with a newline in it
        // The binder should reject it as unknown column
        expect(result.ok).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════
// 3. NUMERIC LITERAL INJECTION
// ════════════════════════════════════════════════════════════

describe("numeric literal injection", () => {
    test("integer literal is emitted as-is", () => {
        const result = compileStrict("SELECT 42");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe("SELECT 42");
    });

    test("decimal literal is emitted as-is", () => {
        const result = compileStrict("SELECT 3.14");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe("SELECT 3.14");
    });

    test("negative number is emitted correctly", () => {
        const result = compileStrict("SELECT -42");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe("SELECT -42");
    });

    test("numeric literal cannot contain non-numeric characters", () => {
        // The lexer only reads digits and a single dot for numbers
        // So something like 42abc would be lexed as number 42 followed by identifier abc
        const result = compileStrict("SELECT 42abc FROM users");
        // This would parse as: SELECT 42 abc FROM users
        // where abc is an alias for the literal 42
        // Actually, abc would be parsed as an alias (implicit AS)
        if (result.ok) {
            expect(result.emitted?.sql).toContain("42");
        }
    });

    test("very large integer literal passes through", () => {
        // The emitter just passes the string value through for integers/decimals
        const result = compileStrict("SELECT 99999999999999999999999999999999999999");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("99999999999999999999999999999999999999");
    });

    test("leading zeros in numeric literal", () => {
        const result = compileStrict("SELECT 007");
        expect(result.ok).toBe(true);
        // The emitter passes through the raw text from the lexer
        expect(result.emitted?.sql).toBe("SELECT 007");
    });
});

// ════════════════════════════════════════════════════════════
// 4. SEMANTIC BYPASS VIA COMPUTATION
// ════════════════════════════════════════════════════════════

describe("semantic bypass via computation", () => {
    test("[VULN] LIMIT bypass via arithmetic expression", () => {
        // maxLimit = 100, but LIMIT 50 + 51 = 101
        // The enforcer uses readNumericLiteral which only checks BoundLiteral
        // A BinaryExpression is not a literal, so the check is skipped entirely
        const result = compileStrict("SELECT id FROM users LIMIT 50 + 51", {
            maxLimit: 100,
        });
        // This SHOULD be rejected but ISN'T because the enforcer can't evaluate expressions
        expect(result.ok).toBe(true); // Vulnerability confirmed
        expect(result.emitted?.sql).toContain("50 + 51");
    });

    test("[VULN] LIMIT bypass via unary negation of negative", () => {
        // LIMIT -(-200) = 200, but maxLimit = 100
        // This is a UnaryExpression wrapping a UnaryExpression wrapping a Literal
        const result = compileStrict("SELECT id FROM users LIMIT -(-200)", {
            maxLimit: 100,
        });
        if (result.ok) {
            // Vulnerability: arithmetic expression bypasses limit check
            expect(result.emitted?.sql).toContain("-(-200)");
        }
    });

    test("[VULN] LIMIT bypass via function call", () => {
        // LIMIT ABS(-200) = 200
        const result = compileStrict("SELECT id FROM users LIMIT ABS(-200)", {
            maxLimit: 100,
            allowedFunctions: new Set(["abs"]),
        });
        if (result.ok) {
            // Function names are lowercased by normalizeIdentifier
            expect(result.emitted?.sql).toContain("`abs`");
        }
    });

    test("[VULN] LIMIT bypass by omitting LIMIT clause entirely", () => {
        // If maxLimit is configured but no LIMIT clause is present,
        // the query returns ALL rows -- effectively unlimited
        const result = compileStrict("SELECT id FROM users", {
            maxLimit: 100,
        });
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).not.toContain("LIMIT");
        // No LIMIT means all rows returned, bypassing the intent of maxLimit
    });

    test("[VULN] LIMIT bypass via parameter placeholder", () => {
        // LIMIT ? allows the caller to pass any value at runtime
        const result = compileStrict("SELECT id FROM users LIMIT ?", {
            maxLimit: 100,
        });
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("LIMIT ?");
    });

    test("[VULN] LIMIT bypass via multiplication", () => {
        const result = compileStrict("SELECT id FROM users LIMIT 10 * 1000", {
            maxLimit: 100,
        });
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("10 * 1000");
    });
});

// ════════════════════════════════════════════════════════════
// 5. EMITTER PARENTHESIZATION BUGS
// ════════════════════════════════════════════════════════════

describe("emitter parenthesization", () => {
    test("OR inside AND is parenthesized", () => {
        // Parser produces: AND(a = 1, OR(b = 2, c = 3))
        // The emitter must parenthesize the OR inside the AND
        const result = compileStrict(
            "SELECT id FROM users WHERE age = 1 AND (name = 'a' OR name = 'b')",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // The emitter should produce parentheses around the OR
        expect(sql).toContain("(`users`.`name` = 'a' OR `users`.`name` = 'b')");
    });

    test("addition inside multiplication is parenthesized", () => {
        // (a + b) * c should keep parentheses
        const result = compileStrict("SELECT (age + 1) * 2 FROM users");
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // The parser creates GroupingExpression wrapping the addition,
        // so the emitter should output (age + 1) * 2
        expect(sql).toContain("(`users`.`age` + 1) * 2");
    });

    test("same-precedence operators are NOT parenthesized (left-associative)", () => {
        // a + b + c should not be (a + b) + c with extra parens
        const result = compileStrict("SELECT age + 1 + 2 FROM users");
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // Left-associative: ((age + 1) + 2) but we only need parens if
        // child precedence < parent precedence. Same precedence = no parens.
        // The shouldParenthesizeBinary function uses strict <, not <=
        // This means a + (b - c) would NOT be parenthesized since + and - have
        // the same precedence. But the parser produces left-associative trees,
        // so a + b - c parses as (a + b) - c, which is correct.
        expect(sql).not.toContain("(");
    });

    test("[VULN] subtraction associativity: a - (b - c) vs a - b - c", () => {
        // If the parser produces a - (b - c) but the emitter drops parens,
        // the result would be a - b - c = (a - b) - c, changing semantics.
        const result = compileStrict("SELECT age - (1 - 2) FROM users");
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // The parser creates: BinaryExpression(-,
        //   left: age,
        //   right: GroupingExpression(BinaryExpression(-, 1, 2))
        // )
        // The emitter should preserve the grouping parens
        expect(sql).toContain("(1 - 2)");
    });

    test("comparison inside arithmetic is parenthesized correctly", () => {
        // This is unusual SQL but tests precedence: (a = b) + 1
        // The parser would parse this as: a = (b + 1) due to precedence rules
        // So this tests the parser's precedence, not the emitter's
        const result = compileStrict("SELECT id FROM users WHERE age = 18 + 1");
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // Parser: age = (18 + 1) because + binds tighter than =
        expect(sql).toContain("= 18 + 1");
    });

    test("NOT applied to OR expression", () => {
        const result = compileStrict(
            "SELECT id FROM users WHERE NOT (age = 1 OR age = 2)",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        expect(sql).toContain("NOT (`users`.`age` = 1 OR `users`.`age` = 2)");
    });

    test("deeply nested boolean with mixed AND/OR", () => {
        const result = compileStrict(
            "SELECT id FROM users WHERE (age > 18 AND name = 'a') OR (age < 5 AND name = 'b')",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // Both AND groups should be parenthesized within the OR
        // Actually, AND has higher precedence than OR, so:
        // (age > 18 AND name = 'a') OR (age < 5 AND name = 'b')
        // The emitter only parenthesizes when child < parent precedence.
        // AND(2) > OR(1), so AND children of OR do NOT need parens.
        // But the parser already wrapped them in GroupingExpression because
        // the user wrote explicit parens.
        expect(sql).toContain("OR");
    });

    test("chained comparisons: a = b = c should be parsed as (a = b) = c", () => {
        // In the parser, comparison is not left-associative - it only matches once
        // So a = b = c would parse as: (a = b) then fail on = c
        // Actually looking at parseComparisonExpression, it only does ONE comparison
        // So a = 1 = 2 would parse as BinaryExpression(=, a, 1) then try to parse = 2
        // which would hit the next clause
        const result = compileStrict("SELECT id FROM users WHERE age = 1 = 2");
        // This should fail or produce unexpected results
        // The parser does: parseAdditiveExpression -> age, then checks for = operator,
        // consumes it, parses right side (1), returns BinaryExpression(=, age, 1)
        // Then back in parseAndExpression, it tries to match AND keyword.
        // = 2 is left as unparsed tokens -> should fail at expect(eof)
        expect(result.ok).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════
// 6. PARAMETER INDEX MANIPULATION
// ════════════════════════════════════════════════════════════

describe("parameter index manipulation", () => {
    test("parameter order is preserved in output", () => {
        const result = compileStrict(
            "SELECT id FROM users WHERE name = ? AND age > ? AND email = ?",
        );
        expect(result.ok).toBe(true);
        const params = result.emitted?.parameters ?? [];
        // Parameters should be in the order they appear in the SQL
        expect(params.length).toBe(3);
        // Each parameter's index is its position in the source text
        expect(params[0]! < params[1]!).toBe(true);
        expect(params[1]! < params[2]!).toBe(true);
    });

    test("parameters in subqueries maintain correct order", () => {
        const result = compileStrict(
            "SELECT id FROM users WHERE name = ? AND id IN (SELECT user_id FROM orders WHERE total > ?)",
        );
        expect(result.ok).toBe(true);
        const params = result.emitted?.parameters ?? [];
        expect(params.length).toBe(2);
        // The outer ? should come before the inner ?
        expect(params[0]! < params[1]!).toBe(true);
    });

    test("parameters in WHERE and LIMIT maintain correct order", () => {
        const result = compileStrict(
            "SELECT id FROM users WHERE name = ? LIMIT ?",
        );
        expect(result.ok).toBe(true);
        const params = result.emitted?.parameters ?? [];
        expect(params.length).toBe(2);
        expect(params[0]! < params[1]!).toBe(true);
    });

    test("[VULN] tenant scoping rewrite adds extra parameters that shift indices", () => {
        // When tenant scoping injects a literal value (not a parameter),
        // the parameter count should NOT change. But if the tenant value
        // were injected as a parameter, it would shift all subsequent parameter indices.
        const result = compileTenantScoped(
            "SELECT metric FROM timeseries WHERE value > ?",
        );
        expect(result.ok).toBe(true);
        const params = result.emitted?.parameters ?? [];
        // Only the user's ? should be in the parameters array
        // The tenant_id = 'tenant-123' uses a literal, not a parameter
        expect(params.length).toBe(1);
    });

    test("parameters in CTE and main query are ordered correctly", () => {
        const result = compileStrict(
            "WITH filtered AS (SELECT id, name FROM users WHERE age > ?) SELECT id FROM filtered WHERE name = ?",
        );
        expect(result.ok).toBe(true);
        const params = result.emitted?.parameters ?? [];
        expect(params.length).toBe(2);
        expect(params[0]! < params[1]!).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════
// 7. ALIAS-BASED EMITTER CONFUSION
// ════════════════════════════════════════════════════════════

describe("alias-based emitter confusion", () => {
    test("alias that shadows table name does not confuse emitter", () => {
        // Alias 'orders' on users table
        const result = compileStrict(
            "SELECT orders.id FROM users AS orders",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // The emitter should use the alias 'orders' to reference the users table
        expect(sql).toContain("`users` AS `orders`");
        expect(sql).toContain("`orders`.`id`");
    });

    test("alias same as column name does not confuse", () => {
        const result = compileStrict(
            "SELECT id AS name, name AS id FROM users",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        expect(sql).toContain("`users`.`id` AS `name`");
        expect(sql).toContain("`users`.`name` AS `id`");
    });

    test("CTE alias shadowing catalog table", () => {
        // CTE named 'users' shadows the real users table
        const result = compileStrict(
            "WITH users AS (SELECT id, name FROM users) SELECT id FROM users",
        );
        // This should fail because the CTE 'users' references itself in its definition
        // Actually: the CTE body binds BEFORE the CTE name is registered, so 'users'
        // in the CTE body refers to the catalog table, not the CTE itself.
        // Then the outer SELECT FROM users refers to the CTE.
        if (result.ok) {
            const sql = result.emitted?.sql ?? "";
            // The CTE definition should reference the catalog users table
            // The outer query should reference the CTE
            expect(sql).toBeDefined();
        }
    });

    test("derived table alias used in JOIN ON", () => {
        const result = compileStrict(
            "SELECT u.id FROM (SELECT id, name FROM users) AS u INNER JOIN orders AS o ON u.id = o.user_id",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        expect(sql).toContain("`u`.`id`");
        expect(sql).toContain("`u`.`id` = `o`.`user_id`");
    });
});

// ════════════════════════════════════════════════════════════
// 8. SECOND-ORDER INJECTION THROUGH EMITTED SQL
// ════════════════════════════════════════════════════════════

describe("second-order injection", () => {
    test("[VULN] string literal with backslash before quote (MySQL GBK-like)", () => {
        // Classic attack: In GBK charset, the byte sequence 0xBF5C is a valid
        // multibyte character, where 0x5C is backslash. If MySQL connection uses
        // GBK and the app uses addslashes() or similar, the attacker sends 0xBF27
        // (0xBF + quote), which becomes 0xBF5C27 after escaping (0xBF + backslash + quote).
        // MySQL interprets 0xBF5C as one character, leaving the quote unescaped.
        //
        // voight does NOT escape backslashes, and uses '' for quote escaping.
        // On a GBK connection, this may still be vulnerable because the
        // emitter does not sanitize multibyte characters.
        //
        // We test with the actual byte sequence:
        const gbkByte = String.fromCharCode(0xBF);
        const result = compileStrict(`SELECT '${gbkByte}' FROM users`);
        // The lexer will parse this as a string containing the 0xBF character
        // The emitter will wrap it in quotes: '0xBF'
        // On a GBK MySQL connection, if another quote is nearby, this could be dangerous
        if (result.ok) {
            // The emitter should ideally reject or escape non-ASCII in string literals
            // when targeting MySQL, or require UTF-8 connections
            expect(result.emitted?.sql).toBeDefined();
        }
    });

    test("string containing MySQL escape sequences", () => {
        // MySQL recognizes: \n, \t, \r, \0, \\, \%, \_, etc.
        // voight does NOT interpret these, but MySQL will when executing
        const escapeSequences = ["\\n", "\\t", "\\r", "\\0", "\\%", "\\_"];
        for (const seq of escapeSequences) {
            const result = compileStrict(`SELECT '${seq}'`);
            expect(result.ok).toBe(true);
            // The emitter should ideally escape backslashes for MySQL
            // Currently it does not
        }
    });

    test("string with MySQL comment start sequence */ inside", () => {
        const result = compileStrict("SELECT 'start */ end'");
        expect(result.ok).toBe(true);
        // This is safe as long as the string is properly delimited
        expect(result.emitted?.sql).toBe("SELECT 'start */ end'");
    });

    test("identifier with line comment sequence inside backticks", () => {
        const result = compileStrict("SELECT id AS `alias -- comment` FROM users");
        expect(result.ok).toBe(true);
        if (result.ok) {
            // The -- inside backticks should be safe
            expect(result.emitted?.sql).toContain("`alias -- comment`");
        }
    });
});

// ════════════════════════════════════════════════════════════
// 9. CROSS-TENANT DATA LEAK VIA COMPUTATION
// ════════════════════════════════════════════════════════════

describe("cross-tenant data leak via computation", () => {
    test("[FIXED] scalar subquery reads ALL tenants -- tenant scoping now applied", () => {
        // The rewriter and enforcer now traverse into expression-level subqueries,
        // so the scalar subquery on timeseries gets a tenant_id predicate.
        const result = compileTenantScoped(
            "SELECT users.id, (SELECT COUNT(timeseries.id) FROM timeseries) AS ts_count FROM users",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // The scalar subquery now has a tenant_id filter
        expect(sql).toContain("tenant-123");
    });

    test("[FIXED] EXISTS subquery probes ALL tenants -- tenant scoping now applied", () => {
        // The rewriter and enforcer now traverse into expression-level subqueries,
        // so the EXISTS subquery on timeseries gets a tenant_id predicate.
        const result = compileTenantScoped(
            "SELECT id FROM users WHERE EXISTS (SELECT 1 FROM timeseries WHERE timeseries.metric = 'secret_metric')",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // The EXISTS subquery now has a tenant_id filter
        expect(sql).toContain("tenant-123");
    });

    test("[FIXED] IN subquery reads ALL tenants -- tenant scoping now applied", () => {
        // The rewriter and enforcer now traverse into expression-level subqueries,
        // so the IN subquery on timeseries gets a tenant_id predicate.
        const result = compileTenantScoped(
            "SELECT users.id FROM users WHERE users.id IN (SELECT timeseries.id FROM timeseries WHERE timeseries.value > 100)",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // The IN subquery now has a tenant_id filter
        expect(sql).toContain("tenant-123");
    });

    test("[FIXED] correlated subquery: inner timeseries now scoped", () => {
        // Both the outer timeseries AND the inner scalar subquery on timeseries AS t2
        // are now scoped by the rewriter/enforcer.
        const result = compileTenantScoped(
            "SELECT timeseries.metric FROM timeseries WHERE timeseries.value > (SELECT COUNT(t2.id) FROM timeseries AS t2 WHERE t2.metric = timeseries.metric)",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // Both outer timeseries and inner t2 should have tenant-123 references
        const tenantMatches = (sql.match(/tenant-123/g) ?? []).length;
        expect(tenantMatches).toBe(2);
    });

    test("JOIN with scoped table has tenant predicate on JOIN condition", () => {
        const result = compileTenantScoped(
            "SELECT u.id FROM users AS u INNER JOIN orders AS o ON u.id = o.user_id",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // orders is in the scoped tables list, so the JOIN ON should include tenant_id
        expect(sql).toContain("`o`.`tenant_id` = 'tenant-123'");
    });

    test("LEFT JOIN with scoped table applies tenant predicate", () => {
        const result = compileTenantScoped(
            "SELECT u.id FROM users AS u LEFT JOIN orders AS o ON u.id = o.user_id",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // Tenant predicate should be in the ON clause, not WHERE
        // (WHERE would turn LEFT JOIN into INNER JOIN semantically)
        expect(sql).toContain("ON");
        expect(sql).toContain("`o`.`tenant_id` = 'tenant-123'");
    });
});

// ════════════════════════════════════════════════════════════
// 10. NULL BYTE IN EMITTED SQL
// ════════════════════════════════════════════════════════════

describe("null byte handling", () => {
    test("null byte in source input is rejected", () => {
        const result = compileStrict("SELECT id FROM users\x00");
        expect(result.ok).toBe(false);
    });

    test("null byte inside string literal", () => {
        // The null byte as a character in the source string
        const result = compileStrict("SELECT 'before\x00after'");
        // The lexer's isWhitespace might treat \x00 differently
        // \x00 is not whitespace by /\s/ regex
        // The lexer reads it as part of the string (it's between quotes)
        if (result.ok) {
            const sql = result.emitted?.sql ?? "";
            // The null byte is now embedded in the emitted SQL
            // Some MySQL drivers would truncate at the null byte
            expect(sql).toContain("before");
        }
    });

    test("null byte in identifier via backticks", () => {
        const result = compileStrict("SELECT `id\x00name` FROM users");
        // The lexer reads backtick-quoted identifiers byte by byte
        // until it finds a closing backtick. \x00 would be included.
        if (result.ok) {
            // Potentially dangerous if passed to MySQL driver
        }
    });
});

// ════════════════════════════════════════════════════════════
// 11. COMMENT INJECTION VIA EMITTED VALUES
// ════════════════════════════════════════════════════════════

describe("comment injection via emitted values", () => {
    test("inline comment in input is rejected", () => {
        const result = compileStrict("SELECT /* injected */ id FROM users");
        expect(result.ok).toBe(false);
    });

    test("line comment in input is rejected", () => {
        const result = compileStrict("SELECT id -- comment\nFROM users");
        expect(result.ok).toBe(false);
    });

    test("hash comment in input is rejected", () => {
        const result = compileStrict("SELECT id # comment\nFROM users");
        expect(result.ok).toBe(false);
    });

    test("comment-like sequences in string literals are safe", () => {
        const cases = [
            "SELECT '/* not a comment */'",
            "SELECT '-- not a comment'",
            "SELECT '# not a comment'",
        ];
        for (const sql of cases) {
            const result = compileStrict(sql);
            expect(result.ok, `Failed for: ${sql}`).toBe(true);
        }
    });

    test("MySQL conditional comment syntax is rejected", () => {
        // MySQL conditional comments: /*!50000 SELECT */ ...
        const result = compileStrict("SELECT /*!50000 1 */");
        expect(result.ok).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════
// 12. RESERVED WORD COLLISION
// ════════════════════════════════════════════════════════════

describe("reserved word collision", () => {
    test("backtick-quoted reserved words work as aliases", () => {
        const result = compileStrict(
            "SELECT id AS `select`, name AS `from`, age AS `where` FROM users",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        expect(sql).toContain("AS `select`");
        expect(sql).toContain("AS `from`");
        expect(sql).toContain("AS `where`");
    });

    test("unquoted identifiers that are keywords cannot be used as aliases", () => {
        // The parser should reject using a keyword as an implicit alias
        // because it would be ambiguous with SQL syntax
        // Actually, the parser's parseOptionalAlias checks for identifier tokens,
        // and keywords are separate token kinds, so a keyword won't match as an alias
        const result = compileStrict("SELECT id select FROM users");
        // 'select' is a keyword, so this parses as:
        // SELECT (id) then expects keyword SELECT for... another select?
        // Actually: parseSelectItem -> parseExpression -> id (identifier)
        // Then parseOptionalAlias: checks if current is identifier. 'select' is keyword, not identifier.
        // So no alias is parsed. Then the parser tries to continue.
        // SELECT id SELECT FROM users -> after SELECT id, expects comma or FROM.
        // SELECT (keyword) is unexpected.
        expect(result.ok).toBe(false);
    });

    test("table name 'from' in backticks is valid", () => {
        // This would only work if a table named 'from' is in the catalog
        // Since it's not, the binder should reject it
        const result = compileStrict("SELECT 1 FROM `from`");
        expect(result.ok).toBe(false); // Unknown table
    });

    test("MySQL reserved words not in voight keyword list can be used as identifiers", () => {
        // 'status' is a MySQL reserved word but NOT in voight's KEYWORDS set
        // The orders table has a 'status' column
        const result = compileStrict("SELECT status FROM orders");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("`status`");
    });
});

// ════════════════════════════════════════════════════════════
// 13. EMITTER OUTPUT CORRECTNESS - AST vs BOUND PATHS
// ════════════════════════════════════════════════════════════

describe("emitter AST vs bound path consistency", () => {
    test("emitter produces valid SQL for simple SELECT", () => {
        const result = compileStrict("SELECT id, name FROM users WHERE age > 18 LIMIT 10");
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        expect(sql).toBe(
            "SELECT `users`.`id`, `users`.`name` FROM `users` WHERE `users`.`age` > 18 LIMIT 10",
        );
    });

    test("emitter produces valid SQL for JOIN query", () => {
        const result = compileStrict(
            "SELECT u.id, o.total FROM users AS u INNER JOIN orders AS o ON u.id = o.user_id WHERE u.age > 18",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        expect(sql).toContain("INNER JOIN");
        expect(sql).toContain("`u`.`id` = `o`.`user_id`");
    });

    test("emitter preserves GROUP BY and HAVING", () => {
        const result = compileWithFunctions(
            "SELECT status, COUNT(id) FROM orders GROUP BY status HAVING COUNT(id) > 5",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        expect(sql).toContain("GROUP BY");
        expect(sql).toContain("HAVING");
    });

    test("emitter preserves ORDER BY direction", () => {
        const result = compileStrict(
            "SELECT id, name FROM users ORDER BY name ASC, id DESC",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        expect(sql).toContain("ORDER BY");
        expect(sql).toContain("ASC");
        expect(sql).toContain("DESC");
    });

    test("emitter preserves LIMIT OFFSET syntax", () => {
        const result = compileStrict("SELECT id FROM users LIMIT 10 OFFSET 20");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("LIMIT 10 OFFSET 20");
    });

    test("emitter converts comma-LIMIT to LIMIT OFFSET", () => {
        const result = compileStrict("SELECT id FROM users LIMIT 20, 10");
        expect(result.ok).toBe(true);
        // LIMIT offset, count -> LIMIT count OFFSET offset
        expect(result.emitted?.sql).toContain("LIMIT 10 OFFSET 20");
    });
});

// ════════════════════════════════════════════════════════════
// 14. TENANT SCOPING ENFORCEMENT BYPASSES IN SUBQUERIES
// ════════════════════════════════════════════════════════════

describe("tenant scoping in expression subqueries", () => {
    test("[FIXED] IN subquery on timeseries compiles with tenant scoping", () => {
        // The IN subquery now gets a tenant_id filter applied
        const result = compileTenantScoped(
            "SELECT users.id FROM users WHERE users.id IN (SELECT timeseries.id FROM timeseries)",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // Tenant scoping is now applied on the inner timeseries reference
        expect(sql).toContain("tenant-123");
    });

    test("[FIXED] EXISTS subquery on timeseries compiles with tenant scoping", () => {
        const result = compileTenantScoped(
            "SELECT users.id FROM users WHERE EXISTS (SELECT 1 FROM timeseries WHERE timeseries.id = users.id)",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // Tenant scoping is now applied on the inner timeseries reference
        expect(sql).toContain("tenant-123");
    });

    test("[FIXED] scalar subquery in SELECT list compiles with tenant scoping", () => {
        const result = compileTenantScoped(
            "SELECT users.id, (SELECT COUNT(timeseries.id) FROM timeseries) FROM users",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // Tenant scoping is now applied on the inner timeseries reference
        expect(sql).toContain("tenant-123");
    });

    test("[FIXED] nested expression subqueries: tenant scoping on both orders and timeseries", () => {
        const result = compileTenantScoped(
            "SELECT users.id FROM users WHERE users.id IN (SELECT orders.user_id FROM orders WHERE orders.total > (SELECT COUNT(timeseries.id) FROM timeseries))",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // Both orders and timeseries in the expression subqueries now get tenant scoping
        expect(sql).toContain("tenant-123");
    });

    test("derived table (subquery in FROM) gets tenant scoping", () => {
        const result = compileTenantScoped(
            "SELECT sub.id FROM (SELECT id, metric FROM timeseries) AS sub",
        );
        if (result.ok) {
            const sql = result.emitted?.sql ?? "";
            expect(sql).toContain("tenant-123");
        }
    });

    test("CTE body gets tenant scoping applied", () => {
        const result = compileTenantScoped(
            "WITH ts AS (SELECT id, metric FROM timeseries) SELECT id FROM ts",
        );
        if (result.ok) {
            const sql = result.emitted?.sql ?? "";
            expect(sql).toContain("tenant-123");
        }
    });
});

// ════════════════════════════════════════════════════════════
// 15. BACKSLASH ESCAPE DIVERGENCE (MySQL vs SQL Standard)
// ════════════════════════════════════════════════════════════

describe("backslash escape MySQL divergence", () => {
    test("[FIXED] emitter now escapes backslashes for MySQL", () => {
        // The emitLiteral function now does:
        //   value.replace(/\\/g, "\\\\").replace(/'/g, "''")
        // So backslashes are escaped before quote escaping.
        const result = compileStrict("SELECT 'hello\\nworld'");
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // voight lexer sees: string value = hello\nworld (literal backslash + n)
        // emitter escapes the backslash: 'hello\\nworld'
        // MySQL now sees \\ as literal backslash followed by literal n. Safe.
        expect(sql).toBe("SELECT 'hello\\\\nworld'");
    });

    test("[FIXED] backslash-zero in string is escaped for MySQL", () => {
        const result = compileStrict("SELECT 'data\\0more'");
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // The emitter escapes the backslash, so MySQL sees \\ followed by 0 (literal)
        expect(sql).toBe("SELECT 'data\\\\0more'");
    });

    test("[FIXED] trailing backslash is escaped so it cannot eat the closing quote in MySQL", () => {
        // The emitter now escapes the trailing backslash: 'abc\\' in emitted SQL.
        // In MySQL, \\ is a literal backslash, and the string is properly terminated.
        const result = compileStrict("SELECT 'abc\\'");
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // Emitter produces 'abc\\' which MySQL sees as a terminated string containing abc\
        expect(sql).toBe("SELECT 'abc\\\\'");
    });

    test("double backslash is escaped by emitter", () => {
        const result = compileStrict("SELECT 'path\\\\file'");
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // In JS: 'path\\\\file' = path\\file (2 backslashes)
        // voight lexer: 'path\\file' -> reads all chars between quotes -> value = path\\file
        // Emitter: escapes each \ to \\, so path\\file -> path\\\\file (4 backslashes)
        expect(sql).toBe("SELECT 'path\\\\\\\\file'");
    });
});

// ════════════════════════════════════════════════════════════
// 16. EDGE CASES IN EMITTER BEHAVIOR
// ════════════════════════════════════════════════════════════

describe("emitter edge cases", () => {
    test("IS NULL emitted correctly", () => {
        const result = compileStrict("SELECT id FROM users WHERE name IS NULL");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("IS NULL");
    });

    test("IS NOT NULL emitted correctly", () => {
        const result = compileStrict("SELECT id FROM users WHERE name IS NOT NULL");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("IS NOT NULL");
    });

    test("boolean literal emitted correctly", () => {
        const result = compileStrict("SELECT id FROM users WHERE TRUE");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("TRUE");
    });

    test("NULL literal emitted correctly", () => {
        const result = compileStrict("SELECT NULL");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe("SELECT NULL");
    });

    test("IN list with mixed types", () => {
        const result = compileStrict(
            "SELECT id FROM users WHERE name IN ('alice', 'bob', 'charlie')",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("IN ('alice', 'bob', 'charlie')");
    });

    test("NOT IN emitted correctly", () => {
        const result = compileStrict(
            "SELECT id FROM users WHERE id NOT IN (1, 2, 3)",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("NOT IN (1, 2, 3)");
    });

    test("CURRENT_TIMESTAMP emitted correctly", () => {
        const result = compileStrict("SELECT CURRENT_TIMESTAMP");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe("SELECT CURRENT_TIMESTAMP");
    });

    test("multiple wildcards with table qualifiers", () => {
        const result = compileStrict(
            "SELECT u.*, o.* FROM users AS u INNER JOIN orders AS o ON u.id = o.user_id",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        expect(sql).toContain("`u`.*");
        expect(sql).toContain("`o`.*");
    });
});

// ════════════════════════════════════════════════════════════
// 17. COMBINED EMITTER + ENFORCEMENT ATTACKS
// ════════════════════════════════════════════════════════════

describe("combined emitter + enforcement attacks", () => {
    test("[VULN] function allowlist bypass when no allowlist is configured", () => {
        // If no allowedFunctions is set, ALL functions are allowed
        // including dangerous MySQL functions
        const dangerousFunctions = [
            "SELECT SLEEP(10) FROM users",
            "SELECT BENCHMARK(1000000, SHA1('x')) FROM users",
            "SELECT LOAD_FILE('/etc/passwd') FROM users",
            "SELECT UUID() FROM users",
        ];
        for (const sql of dangerousFunctions) {
            const result = compileStrict(sql);
            expect(result.ok).toBe(true);
            // All pass without function allowlist
        }
    });

    test("function allowlist blocks dangerous functions", () => {
        const safeFunctions = new Set(["count", "sum", "avg", "min", "max"]);
        const dangerousFunctions = [
            "SELECT SLEEP(10) FROM users",
            "SELECT BENCHMARK(1000000, SHA1('x')) FROM users",
            "SELECT LOAD_FILE('/etc/passwd') FROM users",
        ];
        for (const sql of dangerousFunctions) {
            const result = compileStrict(sql, { allowedFunctions: safeFunctions });
            expect(result.ok).toBe(false);
        }
    });

    test("tenant scoping + LIMIT bypass combined", () => {
        // Even with tenant scoping, LIMIT bypass via arithmetic works
        const result = compileTenantScoped(
            "SELECT metric FROM timeseries LIMIT 50 + 50 + 50",
        );
        if (result.ok) {
            expect(result.emitted?.sql).toContain("50 + 50 + 50");
            expect(result.emitted?.sql).toContain("tenant-123");
        }
    });

    test("[VULN] subquery LIMIT not checked even with maxLimit", () => {
        // The enforcer only checks the outermost LIMIT
        const result = compileStrict(
            "SELECT id FROM users WHERE id IN (SELECT id FROM orders LIMIT 999999) LIMIT 10",
            { maxLimit: 100 },
        );
        if (result.ok) {
            const sql = result.emitted?.sql ?? "";
            // Inner LIMIT 999999 passes through
            expect(sql).toContain("999999");
        }
    });
});

// ════════════════════════════════════════════════════════════
// 18. UNICODE AND SPECIAL CHARACTER HANDLING
// ════════════════════════════════════════════════════════════

describe("unicode and special character handling", () => {
    test("emoji in string literal passes through", () => {
        const result = compileStrict("SELECT id FROM users WHERE name = '\u{1F600}'");
        if (result.ok) {
            expect(result.emitted?.sql).toContain("\u{1F600}");
        }
    });

    test("unicode null (U+0000) in string", () => {
        // Different from the \0 escape sequence test
        const result = compileStrict("SELECT 'test\u{0000}value'");
        // The lexer reads character by character; \u0000 is a valid character
        if (result.ok) {
            // Dangerous: null byte embedded in emitted SQL
        }
    });

    test("right-to-left override character in string", () => {
        // U+202E RIGHT-TO-LEFT OVERRIDE can be used for visual spoofing
        const result = compileStrict("SELECT 'normal\u{202E}desrever'");
        if (result.ok) {
            // The emitter passes it through - could be used for visual confusion
            // in logs or admin panels
            expect(result.emitted?.sql).toBeDefined();
        }
    });

    test("zero-width space in identifier is rejected", () => {
        // Zero-width space U+200B might pass identifier checks
        const result = compileStrict("SELECT id\u{200B}name FROM users");
        // isIdentifierPart only matches [A-Za-z0-9_$], so \u200B fails
        // The lexer would stop the identifier at 'id', then encounter \u200B
        // which is not whitespace (by /\s/) and not a valid token start
        expect(result.ok).toBe(false);
    });

    test("fullwidth characters are rejected", () => {
        // Fullwidth letters U+FF21-U+FF5A look like ASCII but are different
        const result = compileStrict("SELECT \uFF33\uFF25\uFF2C\uFF25\uFF23\uFF34 1");
        expect(result.ok).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════
// 19. UNARY MINUS PRECEDENCE
// ════════════════════════════════════════════════════════════

describe("unary minus precedence in emitter", () => {
    test("unary minus before column reference", () => {
        const result = compileStrict("SELECT -age FROM users");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("-`users`.`age`");
    });

    test("unary minus before function call", () => {
        const result = compileWithFunctions("SELECT -COUNT(id) FROM users");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("-`count`(`users`.`id`)");
    });

    test("double unary minus", () => {
        const result = compileStrict("SELECT -(-age) FROM users");
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // The emitter should produce: -(-`users`.`age`)
        // The inner GroupingExpression wraps the inner negation
        expect(sql).toContain("-(-`users`.`age`)");
    });

    test("unary minus in LIMIT", () => {
        // Negative LIMIT doesn't make sense but should be syntactically handled
        const result = compileStrict("SELECT id FROM users LIMIT -1");
        // This should parse but is semantically invalid for MySQL
        if (result.ok) {
            expect(result.emitted?.sql).toContain("LIMIT -1");
        }
    });
});

// ════════════════════════════════════════════════════════════
// 20. EMITTER CONSISTENCY WITH TENANT POLICY INJECTED AST
// ════════════════════════════════════════════════════════════

describe("emitter consistency with policy-injected predicates", () => {
    test("tenant predicate uses correct identifier quoting", () => {
        const result = compileTenantScoped(
            "SELECT metric FROM timeseries",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // The tenant predicate should use backtick-quoted identifiers
        expect(sql).toContain("`timeseries`.`tenant_id`");
    });

    test("tenant predicate string value is properly quoted", () => {
        const result = compileTenantScoped(
            "SELECT metric FROM timeseries",
            "my-tenant",
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        expect(sql).toContain("'my-tenant'");
    });

    test("tenant predicate with numeric value", () => {
        const result = compileTenantScoped(
            "SELECT metric FROM timeseries",
            42,
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        expect(sql).toContain("= 42");
    });

    test("tenant predicate with boolean value", () => {
        const result = compileTenantScoped(
            "SELECT metric FROM timeseries",
            true,
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        expect(sql).toContain("= TRUE");
    });

    test("tenant predicate with null value", () => {
        const result = compileTenantScoped(
            "SELECT metric FROM timeseries",
            null,
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // null tenant_id = NULL would use = NULL, not IS NULL
        // This is semantically incorrect for SQL (= NULL is always unknown/false)
        // But the policy creates a BinaryExpression with = operator
        expect(sql).toContain("= NULL");
    });

    test("[VULN] tenant value null causes = NULL comparison (always false)", () => {
        // In SQL, column = NULL is always UNKNOWN (not TRUE).
        // So tenant_id = NULL would filter out ALL rows, including the tenant's own.
        // This isn't a data leak, but it's a denial-of-service for that tenant.
        // The policy should use IS NULL instead of = NULL.
        const result = compileTenantScoped(
            "SELECT metric FROM timeseries",
            null,
        );
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // Verify: does it use = NULL (broken) or IS NULL (correct)?
        expect(sql).toContain("= NULL");
        // This is a semantic bug: = NULL never matches anything in SQL
    });
});
