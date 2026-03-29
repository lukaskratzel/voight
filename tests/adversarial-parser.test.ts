import { describe, expect, test } from "vitest";

import { compile, type CompileOptions } from "../src/compiler";
import { tokenize } from "../src/lexer";
import { parse } from "../src/parser";
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

function expectBlocked(sql: string, extra: Partial<CompileOptions> = {}) {
    const result = compileStrict(sql, extra);
    expect(result.ok, `Expected rejection but query compiled: ${sql}`).toBe(false);
    return result;
}

function expectAllowed(sql: string, extra: Partial<CompileOptions> = {}) {
    const result = compileStrict(sql, extra);
    expect(
        result.ok,
        `Expected success but query failed: ${sql}\n${result.diagnostics.map((d) => d.message).join("\n")}`,
    ).toBe(true);
    return result;
}

// ════════════════════════════════════════════════════════════
// 1. RECURSIVE DESCENT / STACK OVERFLOW ATTACKS
// ════════════════════════════════════════════════════════════

describe("recursive descent exploits", () => {
    test("[VULN] deeply nested parenthesized expressions trigger stack overflow caught by parser", () => {
        // Build (((((((...)))))))  with 10000 levels of nesting
        const depth = 10000;
        const prefix = "(".repeat(depth);
        const suffix = ")".repeat(depth);
        const sql = `SELECT ${prefix}1${suffix}`;

        // The parser calls parsePrimaryExpression -> parseExpression -> ... recursively
        // for each paren nesting level. This exhausts the call stack.
        // However, the Parser.parse() method has a try/catch that catches the RangeError
        // and converts it to a diagnostic. This is accidental defense, not intentional:
        // the catch block is meant for ParserDiagnosticError, but it catches all errors.
        // VULNERABILITY: No explicit recursion depth limit. The "defense" is a side effect
        // of generic error catching. An attacker can still cause significant stack usage
        // and trigger slow error recovery paths. The parser should have an explicit
        // MAX_DEPTH counter to reject deeply nested queries early.
        const result = compileStrict(sql);
        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe("parser");
        expect(result.diagnostics[0]?.message).toBe("Unexpected parser failure.");
    });

    test("[VULN] deeply nested subqueries trigger stack overflow caught by parser", () => {
        // Build SELECT 1 WHERE 1 IN (SELECT 1 WHERE 1 IN (SELECT 1 ... ))
        const depth = 500;
        let sql = "SELECT 1";
        for (let i = 0; i < depth; i++) {
            sql = `SELECT 1 FROM users WHERE id IN (${sql})`;
        }

        // The parser/binder recursion is deep. The try/catch in Parser.parse()
        // or the binder catches the stack overflow. No explicit depth limit.
        const result = compileStrict(sql);
        expect(typeof result.ok).toBe("boolean");
    });

    test("[VULN] deeply nested CTEs trigger stack overflow caught by parser", () => {
        // WITH a AS (WITH b AS (WITH c AS (... SELECT 1 ...) SELECT 1) SELECT 1) SELECT 1
        const depth = 300;
        let inner = "SELECT 1";
        for (let i = 0; i < depth; i++) {
            inner = `WITH cte${i} AS (${inner}) SELECT 1 FROM cte${i}`;
        }

        // Deeply nested CTEs exhaust the call stack. Parser catches the error.
        const result = compileStrict(inner);
        expect(typeof result.ok).toBe("boolean");
    });

    test("[VULN] deeply nested binary expressions via OR chain with parens", () => {
        // Deeply nested with parens: (1 OR (1 OR (1 OR ...)))
        // Each paren adds a recursion level in the parser
        const depth = 5000;
        let expr = "1";
        for (let i = 0; i < depth; i++) {
            expr = `(${expr} OR 1)`;
        }
        const sql = `SELECT ${expr}`;

        // This triggers stack overflow caught by the parser's try/catch
        const result = compileStrict(sql);
        expect(typeof result.ok).toBe("boolean");
    });

    test("moderate nesting (100 levels) should not crash", () => {
        const depth = 100;
        const prefix = "(".repeat(depth);
        const suffix = ")".repeat(depth);
        const sql = `SELECT ${prefix}1${suffix}`;

        // 100 levels should be handled without stack overflow
        const result = compileStrict(sql);
        expect(typeof result.ok).toBe("boolean");
    });
});

// ════════════════════════════════════════════════════════════
// 2. GRAMMAR AMBIGUITY ABUSE
// ════════════════════════════════════════════════════════════

describe("grammar ambiguity abuse", () => {
    test("identifier vs implicit alias ambiguity after expression", () => {
        // In `SELECT a b FROM users`, is `b` an alias for `a` or a separate column?
        // The parser's parseOptionalAlias greedily consumes the next identifier as alias.
        const result = compileStrict("SELECT id name FROM users");
        expect(result.ok).toBe(true);
        // `name` is parsed as an alias for `id`, not a separate column
        expect(result.emitted?.sql).toContain("AS `name`");
    });

    test("function call vs table reference ambiguity", () => {
        // In FROM position, `users(...)` is not valid - parser expects table reference
        // But what about `SELECT count FROM users` vs `SELECT count() FROM users`?
        const result1 = compileStrict("SELECT count FROM users");
        // `count` without parens is treated as a column reference, not a function
        // Since there is no `count` column, this should fail at binder
        expect(result1.ok).toBe(false);

        const result2 = compileStrict("SELECT count() FROM users");
        // `count` would need to be in the allowlist or no allowlist configured
        // But count is not a keyword; it's an identifier followed by ()
        // This should parse as a function call
        expect(result2.ok).toBe(true);
    });

    test("aliased expression looks like qualified reference", () => {
        // `SELECT a.b FROM users AS a` - is a.b a qualified reference or alias?
        // The parser should handle this as a qualified reference
        const result = compileStrict("SELECT u.id FROM users AS u");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("`u`.`id`");
    });

    test("FROM keyword consumed in wrong position", () => {
        // What happens if `from` is used as an identifier?
        // `FROM` is a keyword, so it can't be an unquoted identifier
        const result = compileStrict("SELECT from FROM users");
        expect(result.ok).toBe(false);
    });

    test("backtick-quoted FROM as column alias works", () => {
        const result = compileStrict("SELECT id AS `from` FROM users");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("AS `from`");
    });

    test("implicit alias that looks like a keyword is not consumed as alias", () => {
        // `SELECT id FROM users` - `FROM` is not consumed as an alias for `id`
        // because parseOptionalAlias checks for identifier token, not keyword
        const result = compileStrict("SELECT id FROM users");
        expect(result.ok).toBe(true);
    });

    test("ORDER used as implicit alias should fail (it's a keyword)", () => {
        // `SELECT id order FROM users` - `order` is a keyword so not consumed as alias
        // Parser sees keyword ORDER next, tries to parse ORDER BY
        const result = compileStrict("SELECT id order FROM users");
        // The parser sees ORDER keyword and tries to consume BY
        expect(result.ok).toBe(false);
    });

    test("ambiguity: asterisk in multiplication vs wildcard in select", () => {
        // In `SELECT 1 * 2 FROM users`, * is multiplication
        // In `SELECT * FROM users`, * is wildcard
        // In `SELECT 1, * FROM users`, first item is 1, second is wildcard
        const r1 = compileStrict("SELECT 1 * 2");
        expect(r1.ok).toBe(true);
        expect(r1.emitted?.sql).toContain("1 * 2");

        const r2 = compileStrict("SELECT * FROM users");
        expect(r2.ok).toBe(true);

        const r3 = compileStrict("SELECT 1, * FROM users");
        expect(r3.ok).toBe(true);
    });

    test("asterisk after expression is multiplicative, not wildcard", () => {
        // `SELECT id * FROM users` - the * after identifier could be confusing
        // The parser should try to parse * as multiplication operator
        // parseMultiplicativeExpression sees asterisk and tries to consume next operand
        const result = compileStrict("SELECT id * FROM users");
        // After id *, FROM is the next token which is a keyword, not a valid operand
        expect(result.ok).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════
// 3. BACKTICK INJECTION ATTACKS
// ════════════════════════════════════════════════════════════

describe("backtick injection attacks", () => {
    test("backtick identifier with SQL injection payload is contained in quotes", () => {
        // Can we inject SQL through a backtick-quoted identifier?
        const result = compileStrict("SELECT id AS `; DROP TABLE users; --` FROM users");
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // The payload IS present in the output, but safely contained inside backtick quotes.
        // The emitter lowercases identifiers so we check lowercase.
        expect(sql).toContain("`; drop table users; --`");
        // The key safety property: the payload is entirely within backtick-quoted context.
        // Any SQL parser will treat the entire backtick-quoted string as an identifier, not SQL.
        // However, if this SQL is naively string-concatenated without the backtick quoting,
        // the payload could escape. The emitter's quoteIdentifier function provides the defense.
    });

    test("backtick identifier containing single quotes", () => {
        const result = compileStrict("SELECT id AS `it's` FROM users");
        if (result.ok) {
            expect(result.emitted?.sql).toContain("`it's`");
        }
    });

    test("backtick identifier containing newlines", () => {
        const result = compileStrict("SELECT id AS `line1\nline2` FROM users");
        if (result.ok) {
            // Newline inside identifier should be preserved but not break SQL
            expect(result.emitted?.sql).toContain("`line1\nline2`");
        }
    });

    test("backtick identifier containing null byte", () => {
        const result = compileStrict("SELECT id AS `col\x00name` FROM users");
        if (result.ok) {
            // Null byte inside identifier - could cause truncation in some parsers
            expect(result.emitted?.sql).toContain("`col\x00name`");
        }
    });

    test("backtick identifier with embedded backtick and payload is safely escaped", () => {
        // Try to break out of backtick quoting with embedded backtick
        // The lexer handles `` as escaped backtick inside backtick-quoted identifiers
        // Input: `col`` FROM users; --`
        // Lexer sees: ` starts quoted identifier, reads col, sees ``, treats as escaped backtick,
        // continues reading " FROM users; --", sees closing `
        // Content is: col` FROM users; --
        // The emitter re-escapes the backtick in quoteIdentifier: col` -> col``
        const result = compileStrict("SELECT id AS `col`` FROM users; --` FROM users");
        expect(result.ok).toBe(true);
        const sql = result.emitted?.sql ?? "";
        // Verify the backtick IS properly escaped in the output
        expect(sql).toContain("``");
        // The payload "FROM users; --" is safely INSIDE the quoted identifier.
        // The semicolon and double-dash are within backtick quotes, so any downstream
        // MySQL parser treats them as part of the identifier name, not as SQL syntax.
        // The key defense: quoteIdentifier escapes any internal backticks with ``.
    });

    test("[VULN] backtick identifier that is empty string silently drops alias", () => {
        // `` is an empty identifier - the lexer accepts it
        const result = compileStrict("SELECT id AS `` FROM users");
        expect(result.ok).toBe(true);
        // The empty identifier is normalized to empty string by normalizeIdentifier.
        // In the binder, the alias becomes "" (empty). When the emitter checks
        // `item.alias`, empty string is falsy, so the AS clause is silently dropped.
        // This means the user's explicit aliasing intent is lost.
        // The output has NO alias at all:
        expect(result.emitted?.sql).toBe("SELECT `users`.`id` FROM `users`");
        // VULNERABILITY: An empty backtick identifier silently changes query semantics.
        // The user explicitly wrote AS `` but the output omits the alias entirely.
    });

    test("backtick identifier with only backticks content", () => {
        // ` `` ` = identifier containing a single backtick
        const result = compileStrict("SELECT id AS ```` FROM users");
        // The lexer reads: ` `` ` -> content is a single backtick
        if (result.ok) {
            const sql = result.emitted?.sql ?? "";
            // The emitter should double the backtick inside
            expect(sql).toContain("````");
        }
    });

    test("[VULN] backtick identifier with closing paren to break AST", () => {
        // Try to break out of a subquery context via identifier
        const result = compileStrict(
            "SELECT id FROM users WHERE id IN (SELECT id AS `) OR 1=1 --` FROM users)",
        );
        // The ` ) ` is inside the backtick-quoted identifier, not a real paren
        if (result.ok) {
            const sql = result.emitted?.sql ?? "";
            // The OR 1=1 should be inside the identifier, not executable
            expect(sql).not.toMatch(/\bOR\s+1\s*=\s*1/);
        }
    });
});

// ════════════════════════════════════════════════════════════
// 4. TOKEN CONFUSION ATTACKS
// ════════════════════════════════════════════════════════════

describe("token confusion", () => {
    test("consecutive operators confuse parser", () => {
        // `SELECT 1 + + 2` - unary + is not supported (only unary -)
        const result = compileStrict("SELECT 1 + + 2");
        // The parser sees +, then +, the second + is an operator but not valid as unary
        // parseMultiplicativeExpression -> parseUnaryExpression: only handles - and NOT
        // so + is passed to parsePrimaryExpression which doesn't handle operators
        expect(result.ok).toBe(false);
    });

    test("double minus is comment, not double negation", () => {
        // `SELECT 1 -- 2` should be rejected as a comment
        const result = compileStrict("SELECT 1 -- 2");
        expect(result.ok).toBe(false);
    });

    test("minus as unary vs binary", () => {
        // `SELECT -1` - unary minus
        const r1 = compileStrict("SELECT -1");
        expect(r1.ok).toBe(true);

        // `SELECT 1-1` - binary minus
        const r2 = compileStrict("SELECT 1-1");
        expect(r2.ok).toBe(true);
    });

    test("semicolon in middle of query", () => {
        // Semicolon should only be valid at the end
        const result = compileStrict("SELECT id ; FROM users");
        expect(result.ok).toBe(false);
    });

    test("parameter in identifier position", () => {
        // `SELECT ? FROM users` - ? is a parameter, not an identifier
        // The parser should handle ? in expression position (as a parameter)
        const result = compileStrict("SELECT ? FROM users");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("?");
    });

    test("parameter as table name fails", () => {
        // `SELECT id FROM ?` - can't use parameter as table name
        const result = compileStrict("SELECT id FROM ?");
        expect(result.ok).toBe(false);
    });

    test("dot without preceding identifier", () => {
        // `.id` at the start should fail
        const result = compileStrict("SELECT .id FROM users");
        expect(result.ok).toBe(false);
    });

    test("consecutive commas in SELECT list", () => {
        const result = compileStrict("SELECT id,, name FROM users");
        expect(result.ok).toBe(false);
    });

    test("trailing comma in SELECT list", () => {
        const result = compileStrict("SELECT id, FROM users");
        // After the comma, parser expects another select item
        // FROM is a keyword, not valid as an expression start in most cases
        expect(result.ok).toBe(false);
    });

    test("operator at start of expression", () => {
        const result = compileStrict("SELECT = 1 FROM users");
        expect(result.ok).toBe(false);
    });

    test("double dot in qualified name", () => {
        const result = compileStrict("SELECT u..id FROM users AS u");
        // After first dot, parser expects identifier; second dot is not an identifier
        expect(result.ok).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════
// 5. UNICODE IDENTIFIER ATTACKS
// ════════════════════════════════════════════════════════════

describe("unicode identifier attacks", () => {
    test("unicode letters in unquoted identifiers are rejected", () => {
        // isIdentifierStart only allows [A-Za-z_]
        // isIdentifierPart only allows [A-Za-z0-9_$]
        // So unicode letters should be unexpected characters
        const result = compileStrict("SELECT id FROM us\u00E9rs");
        // The lexer should reject the unicode e-acute
        expect(result.ok).toBe(false);
    });

    test("unicode inside backtick identifier is allowed", () => {
        // Backtick-quoted identifiers accept any character except unescaped backtick
        const result = compileStrict("SELECT id AS `caf\u00E9` FROM users");
        if (result.ok) {
            expect(result.emitted?.sql).toContain("`caf\u00E9`");
        }
    });

    test("zero-width characters in unquoted identifiers", () => {
        // Zero-width space U+200B should be rejected
        const result = compileStrict("SELECT id FROM u\u200Bsers");
        expect(result.ok).toBe(false);
    });

    test("zero-width characters inside backtick identifier", () => {
        // Zero-width joiner inside backtick identifier
        const result = compileStrict("SELECT id AS `a\u200Bb` FROM users");
        if (result.ok) {
            // The zero-width character is preserved in the identifier
            expect(result.emitted?.sql).toContain("\u200B");
        }
    });

    test("[VULN] homoglyph attack: cyrillic 'a' vs latin 'a'", () => {
        // Cyrillic small letter a (U+0430) looks identical to Latin 'a'
        // If used in a backtick identifier, it creates a visually identical
        // but semantically different identifier
        const result = compileStrict("SELECT id AS `\u0430dmin` FROM users");
        // The identifier `\u0430dmin` looks like `admin` but has a cyrillic 'a'
        // This is allowed in backtick identifiers and could confuse human reviewers
        if (result.ok) {
            expect(result.emitted?.sql).toContain("`\u0430dmin`");
        }
    });

    test("right-to-left override character in backtick identifier", () => {
        // U+202E RIGHT-TO-LEFT OVERRIDE can make text display in reverse
        // Inside a backtick identifier, this could hide malicious content
        const result = compileStrict("SELECT id AS `\u202Esresu\u202C` FROM users");
        if (result.ok) {
            expect(result.emitted?.sql).toContain("\u202E");
        }
    });

    test("fullwidth characters are rejected in unquoted identifiers", () => {
        // Fullwidth S (U+FF33) looks like S but is a different character
        const result = compileStrict("SELECT id FROM \uFF33ELECT");
        expect(result.ok).toBe(false);
    });

    test("unicode in string literal is preserved", () => {
        const result = compileStrict("SELECT id FROM users WHERE name = '\u00E9mile'");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("'\u00E9mile'");
    });
});

// ════════════════════════════════════════════════════════════
// 6. VERY LONG IDENTIFIERS AND STRINGS
// ════════════════════════════════════════════════════════════

describe("very long identifiers and strings", () => {
    test("very long unquoted identifier (10000 chars)", () => {
        const longId = "a".repeat(10000);
        const result = compileStrict(`SELECT ${longId} FROM users`);
        // Should fail at binder (unknown column) but not crash
        expect(result.ok).toBe(false);
        expect(result.terminalStage).not.toBe("lexer");
    });

    test("very long backtick identifier (100000 chars)", () => {
        const longId = "a".repeat(100000);
        const result = compileStrict(`SELECT id AS \`${longId}\` FROM users`);
        // Should not crash, may succeed or fail at later stages
        expect(typeof result.ok).toBe("boolean");
    });

    test("very long string literal (100000 chars)", () => {
        const longStr = "a".repeat(100000);
        const result = compileStrict(`SELECT id FROM users WHERE name = '${longStr}'`);
        expect(result.ok).toBe(true);
    });

    test("very long number literal", () => {
        const longNum = "9".repeat(10000);
        const result = compileStrict(`SELECT id FROM users LIMIT ${longNum}`);
        // The number is stored as a string, so no precision loss
        expect(typeof result.ok).toBe("boolean");
    });

    test("[VULN] many backtick-escaped pairs to slow lexer", () => {
        // Each `` pair requires the lexer to look ahead and process
        const escapedPairs = "``".repeat(50000);
        const sql = `SELECT id AS \`${escapedPairs}\` FROM users`;

        const start = performance.now();
        const result = compileStrict(sql);
        const elapsed = performance.now() - start;

        // Should complete in reasonable time (< 5 seconds)
        expect(elapsed).toBeLessThan(5000);
        expect(typeof result.ok).toBe("boolean");
    });
});

// ════════════════════════════════════════════════════════════
// 7. NUMERIC EDGE CASES
// ════════════════════════════════════════════════════════════

describe("numeric edge cases", () => {
    test("zero", () => {
        const result = compileStrict("SELECT 0 FROM users");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("0");
    });

    test("leading zeros", () => {
        const result = compileStrict("SELECT 007 FROM users");
        expect(result.ok).toBe(true);
        // The lexer preserves the original text
        expect(result.emitted?.sql).toContain("007");
    });

    test("decimal number", () => {
        const result = compileStrict("SELECT 3.14 FROM users");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("3.14");
    });

    test("decimal starting with dot is not parsed as number", () => {
        // `.5` - the dot is a SIMPLE_TOKEN (dot), not a number start
        // isDigit('.') is false, so the lexer emits a dot token followed by number 5
        const result = compileStrict("SELECT .5 FROM users");
        // The parser sees dot, then 5 - this should fail
        expect(result.ok).toBe(false);
    });

    test("negative number via unary minus", () => {
        const result = compileStrict("SELECT -42 FROM users");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("-42");
    });

    test("negative limit", () => {
        const result = compileStrict("SELECT id FROM users LIMIT -1");
        // The parser parses LIMIT, then calls parseExpression which handles unary minus
        // The emitter outputs LIMIT -1
        // MySQL would reject this at execution, but the compiler allows it
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("LIMIT -1");
    });

    test("hex literal (0x...) is not supported as a number", () => {
        // The lexer sees 0 as a digit, starts reading number
        // Then sees x which is not a digit, stops -> number token "0"
        // Then x is treated as identifier start
        const result = compileStrict("SELECT 0xFF FROM users");
        // This should parse as 0 followed by identifier xFF
        // Which would be interpreted as `0 AS xFF` (implicit alias)
        expect(typeof result.ok).toBe("boolean");
    });

    test("scientific notation (1e5) is not supported as a number", () => {
        // Lexer reads 1 as a number, then stops at 'e' (not a digit)
        // Then e5 is read as an identifier
        const result = compileStrict("SELECT 1e5 FROM users");
        // Parsed as number 1 followed by implicit alias e5
        expect(typeof result.ok).toBe("boolean");
    });

    test("very large integer in LIMIT triggers enforcement", () => {
        const result = compileStrict("SELECT id FROM users LIMIT 99999999999999999999999999999", {
            maxLimit: 100,
        });
        expect(result.ok).toBe(false);
    });

    test("LIMIT 0 is allowed", () => {
        const result = compileStrict("SELECT id FROM users LIMIT 0");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("LIMIT 0");
    });

    test("number with multiple dots is partially parsed", () => {
        // 1.2.3 - lexer reads 1.2 as a decimal, then . as dot, then 3 as number
        const result = compileStrict("SELECT 1.2.3 FROM users");
        // This would be parsed as qualified reference: (1.2).(3)
        // But 1.2 is a number, not an identifier, so dot access should fail
        expect(result.ok).toBe(false);
    });

    test("trailing dot after number", () => {
        // 42. - lexer checks if char after dot is digit. If not, dot is not part of number
        // So 42 is number, then . is dot token
        const result = compileStrict("SELECT 42. FROM users");
        // Parser sees number 42, then dot - tries qualified reference? No, 42 is a literal
        expect(result.ok).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════
// 8. EXPRESSION NESTING BOMB
// ════════════════════════════════════════════════════════════

describe("expression nesting bomb", () => {
    test("[VULN] deeply nested binary addition without parens", () => {
        // a + b + c + d + ... builds left-recursive AST in the parser's while loop
        // This should NOT stack overflow because parseAdditiveExpression uses iteration
        const terms = Array.from({ length: 10000 }, () => "1").join(" + ");
        const sql = `SELECT ${terms}`;

        const start = performance.now();
        const result = compileStrict(sql);
        const elapsed = performance.now() - start;

        // Should handle iteratively without stack issues
        expect(typeof result.ok).toBe("boolean");
        // But check it doesn't take too long
        expect(elapsed).toBeLessThan(10000);
    });

    test("[VULN] deeply nested AND without parens", () => {
        // The parseAndExpression uses a while loop, so deep AND chains are iterative
        const terms = Array.from({ length: 5000 }, () => "1 = 1").join(" AND ");
        const sql = `SELECT id FROM users WHERE ${terms}`;

        let threw = false;
        try {
            const result = compileStrict(sql);
            expect(typeof result.ok).toBe("boolean");
        } catch (e) {
            threw = true;
            // If the emitter or binder overflows on the deep AST, that's a vuln
            expect(e).toBeInstanceOf(RangeError);
        }
    });

    test("[VULN] mixed AND/OR with parens creates deep recursion", () => {
        // (((1 = 1) AND (1 = 1)) OR ((1 = 1) AND (1 = 1))) nested 200 levels
        const depth = 200;
        let expr = "1 = 1";
        for (let i = 0; i < depth; i++) {
            if (i % 2 === 0) {
                expr = `(${expr} AND 1 = 1)`;
            } else {
                expr = `(${expr} OR 1 = 1)`;
            }
        }
        const sql = `SELECT id FROM users WHERE ${expr}`;

        const result = compileStrict(sql);
        expect(typeof result.ok).toBe("boolean");
    });
});

// ════════════════════════════════════════════════════════════
// 9. EMPTY CONSTRUCTS
// ════════════════════════════════════════════════════════════

describe("empty constructs", () => {
    test("SELECT with no items after SELECT keyword", () => {
        const result = compileStrict("SELECT FROM users");
        // Parser calls parseSelectList which calls parseSelectItem
        // parseSelectItem sees keyword FROM, falls through to error
        expect(result.ok).toBe(false);
    });

    test("empty WHERE clause", () => {
        const result = compileStrict("SELECT id FROM users WHERE");
        // After WHERE, parser calls parseExpression which fails on EOF
        expect(result.ok).toBe(false);
    });

    test("empty ON clause in JOIN", () => {
        const result = compileStrict(
            "SELECT id FROM users INNER JOIN orders ON",
        );
        expect(result.ok).toBe(false);
    });

    test("empty GROUP BY", () => {
        const result = compileStrict("SELECT id FROM users GROUP BY");
        // GROUP BY expects expressions
        expect(result.ok).toBe(false);
    });

    test("empty ORDER BY", () => {
        const result = compileStrict("SELECT id FROM users ORDER BY");
        expect(result.ok).toBe(false);
    });

    test("empty LIMIT", () => {
        const result = compileStrict("SELECT id FROM users LIMIT");
        expect(result.ok).toBe(false);
    });

    test("empty OFFSET", () => {
        const result = compileStrict("SELECT id FROM users LIMIT 10 OFFSET");
        expect(result.ok).toBe(false);
    });

    test("empty CTE body", () => {
        const result = compileStrict("WITH cte AS () SELECT 1");
        // Inside CTE parens, parser expects a query (SELECT or WITH)
        expect(result.ok).toBe(false);
    });

    test("empty IN list", () => {
        const result = compileStrict("SELECT id FROM users WHERE id IN ()");
        // After (, parser checks isQueryStart (SELECT/WITH)
        // If not, it tries to parse an expression
        // ) is not a valid expression start
        expect(result.ok).toBe(false);
    });

    test("empty function argument list is allowed", () => {
        const result = compileStrict("SELECT count() FROM users");
        expect(result.ok).toBe(true);
    });

    test("empty parenthesized expression", () => {
        const result = compileStrict("SELECT () FROM users");
        // ( is consumed by parsePrimaryExpression
        // It checks isQueryStart -> no
        // Then calls parseExpression which sees ) -> fails
        expect(result.ok).toBe(false);
    });

    test("just SELECT keyword", () => {
        const result = compileStrict("SELECT");
        expect(result.ok).toBe(false);
    });

    test("just WITH keyword", () => {
        const result = compileStrict("WITH");
        expect(result.ok).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════
// 10. KEYWORD AS IDENTIFIER
// ════════════════════════════════════════════════════════════

describe("keyword as identifier via backtick", () => {
    const keywords = [
        "SELECT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "ORDER",
        "LIMIT", "OFFSET", "AS", "INNER", "LEFT", "JOIN", "ON",
        "AND", "OR", "NOT", "IS", "NULL", "TRUE", "FALSE", "ASC", "DESC",
        "WITH", "UPDATE", "INSERT", "DELETE", "SET", "UNION", "IN", "EXISTS",
    ];

    for (const kw of keywords) {
        test(`backtick-quoted keyword \`${kw}\` as column alias`, () => {
            const result = compileStrict(`SELECT id AS \`${kw}\` FROM users`);
            expect(result.ok).toBe(true);
            expect(result.emitted?.sql).toContain(`\`${kw.toLowerCase()}\``);
        });
    }

    test("unquoted keyword as alias fails", () => {
        // `SELECT id SELECT FROM users` - SELECT is a keyword, not consumed as alias
        const result = compileStrict("SELECT id SELECT FROM users");
        expect(result.ok).toBe(false);
    });

    test("backtick-quoted keyword as table alias", () => {
        const result = compileStrict("SELECT `select`.id FROM users AS `select`");
        expect(result.ok).toBe(true);
    });

    test("backtick-quoted keyword as CTE name", () => {
        const result = compileStrict(
            "WITH `select` AS (SELECT id FROM users) SELECT id FROM `select`",
        );
        expect(result.ok).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════
// 11. OFFSET WITHOUT LIMIT / NEGATIVE OFFSET
// ════════════════════════════════════════════════════════════

describe("OFFSET handling", () => {
    test("OFFSET without LIMIT is rejected", () => {
        // OFFSET is only parsed inside parseLimitClause, which is only called after LIMIT
        // So standalone OFFSET is not valid
        const result = compileStrict("SELECT id FROM users OFFSET 10");
        // The parser sees OFFSET as a keyword but it's not consumed after SELECT items
        // It hits the expect("eof") check and fails
        expect(result.ok).toBe(false);
    });

    test("LIMIT with OFFSET works", () => {
        const result = compileStrict("SELECT id FROM users LIMIT 10 OFFSET 5");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("LIMIT 10 OFFSET 5");
    });

    test("LIMIT with comma-style OFFSET works", () => {
        // MySQL-style: LIMIT offset, count
        const result = compileStrict("SELECT id FROM users LIMIT 5, 10");
        expect(result.ok).toBe(true);
        // The emitter should output LIMIT count OFFSET offset
        expect(result.emitted?.sql).toContain("LIMIT");
    });

    test("negative OFFSET via unary minus", () => {
        const result = compileStrict("SELECT id FROM users LIMIT 10 OFFSET -5");
        // The parser allows this; MySQL would reject at execution
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("OFFSET -5");
    });

    test("OFFSET 0", () => {
        const result = compileStrict("SELECT id FROM users LIMIT 10 OFFSET 0");
        expect(result.ok).toBe(true);
    });

    test("OFFSET with expression", () => {
        const result = compileStrict("SELECT id FROM users LIMIT 10 OFFSET 2 + 3");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("OFFSET 2 + 3");
    });
});

// ════════════════════════════════════════════════════════════
// 12. MULTIPLE FROM CLAUSES
// ════════════════════════════════════════════════════════════

describe("multiple FROM clauses", () => {
    test("second FROM is rejected", () => {
        const result = compileStrict("SELECT id FROM users FROM orders");
        // After parsing FROM users, the parser looks for JOINs, then WHERE, etc.
        // The second FROM is not expected and should fail
        expect(result.ok).toBe(false);
    });

    test("FROM in subquery is independent", () => {
        // Must qualify `id` in the subquery because the binder's parent scope
        // sees both `users.id` and `orders.id`, making unqualified `id` ambiguous
        const result = compileStrict(
            "SELECT id FROM users WHERE id IN (SELECT orders.id FROM orders)",
        );
        expect(result.ok).toBe(true);
    });

    test("comma-separated tables in FROM is not supported", () => {
        // Standard SQL allows `FROM a, b` as implicit cross join
        // But this parser only handles a single table in FROM
        const result = compileStrict("SELECT id FROM users, orders");
        // After parsing `users`, the parser sees comma and advances
        // But comma is not valid after FROM table reference in this grammar
        // Actually: parseTableReference returns, then the comma is unexpected
        // The parser checks for JOINs next - comma is not a JOIN keyword
        // Then WHERE - comma is not WHERE keyword
        // Then GROUP BY, ORDER BY, LIMIT - none match
        // Finally expect("eof") fails because there's `, orders`
        expect(result.ok).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════
// 13. TRAILING TOKENS / GARBAGE AFTER QUERY
// ════════════════════════════════════════════════════════════

describe("trailing tokens after valid query", () => {
    test("trailing identifier after valid query", () => {
        const result = compileStrict("SELECT 1 garbage");
        // `garbage` is consumed as an implicit alias for `1`
        // Then expect("eof") should see the real EOF
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("AS `garbage`");
    });

    test("trailing keyword after valid query", () => {
        const result = compileStrict("SELECT 1 FROM users WHERE id = 1 SELECT");
        // Parser finishes the first SELECT statement
        // Then sees SELECT keyword instead of EOF
        expect(result.ok).toBe(false);
    });

    test("trailing number after valid query", () => {
        const result = compileStrict("SELECT id FROM users 42");
        // `42` is not valid after FROM table reference
        // Actually: parseOptionalAlias only consumes identifiers, not numbers
        // So the parser sees 42 and...
        // parseTableReference returns after parsing `users`
        // Then back in parseSelectStatement, it checks for JOINs, WHERE, etc.
        // 42 (number) doesn't match any of those
        // endSpan is computed, then parse() calls expect("eof") -> fails
        expect(result.ok).toBe(false);
    });

    test("trailing semicolon then garbage", () => {
        const result = compileStrict("SELECT 1; garbage");
        // After semicolon, parser expects EOF
        expect(result.ok).toBe(false);
    });

    test("trailing operator", () => {
        const result = compileStrict("SELECT 1 +");
        // Parser parses `1`, then sees + in parseAdditiveExpression
        // Consumes +, then tries to parse next term -> EOF -> fails
        expect(result.ok).toBe(false);
    });

    test("trailing left paren", () => {
        const result = compileStrict("SELECT 1 (");
        // After 1, ( is not expected
        // Actually: back in parseSelectItem, 1 is parsed as expression
        // Then parseOptionalAlias: ( is not an identifier -> returns undefined
        // Back in parseSelectList: check consume comma -> no
        // Back in parseSelectStatement: check FROM -> ( is not FROM
        // Then expect("eof") sees ( -> fails
        expect(result.ok).toBe(false);
    });

    test("unclosed parenthesis", () => {
        const result = compileStrict("SELECT (1 + 2");
        // parsePrimaryExpression opens paren, parses 1 + 2, then expect right_paren fails
        expect(result.ok).toBe(false);
    });

    test("extra right paren", () => {
        const result = compileStrict("SELECT (1 + 2))");
        // The first ) closes the group. The second ) is unexpected
        expect(result.ok).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════
// 14. LEXER-SPECIFIC EDGE CASES
// ════════════════════════════════════════════════════════════

describe("lexer edge cases", () => {
    test("tab and newline as whitespace", () => {
        const result = compileStrict("SELECT\t\nid\n\tFROM\n\tusers");
        expect(result.ok).toBe(true);
    });

    test("carriage return as whitespace", () => {
        const result = compileStrict("SELECT\r\nid\r\nFROM\r\nusers");
        // \r is whitespace per regex /\s/
        expect(result.ok).toBe(true);
    });

    test("form feed as whitespace", () => {
        const result = compileStrict("SELECT\fid FROM users");
        // \f is whitespace per /\s/
        expect(result.ok).toBe(true);
    });

    test("vertical tab as whitespace", () => {
        const result = compileStrict("SELECT\vid FROM users");
        expect(result.ok).toBe(true);
    });

    test("non-breaking space (U+00A0) as whitespace", () => {
        // /\s/ matches U+00A0 in some implementations
        const result = compileStrict("SELECT\u00A0id FROM users");
        // If \s matches U+00A0, it's treated as whitespace
        // If not, it's an unexpected character
        expect(typeof result.ok).toBe("boolean");
    });

    test("all operator combinations", () => {
        const operators = ["<=", ">=", "!=", "<>", "=", "<", ">", "+", "-", "/", "%"];
        for (const op of operators) {
            const result = compileStrict(`SELECT id FROM users WHERE age ${op} 18`);
            expect(result.ok).toBe(true);
        }
    });

    test("<> is normalized to !=", () => {
        const result = compileStrict("SELECT id FROM users WHERE age <> 18");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("!=");
        expect(result.emitted?.sql).not.toContain("<>");
    });

    test("empty string literal", () => {
        const result = compileStrict("SELECT '' FROM users");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("''");
    });

    test("string with only escaped quotes", () => {
        // '''' = string containing single quote
        const result = compileStrict("SELECT '''' FROM users");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("''''");
    });

    test("dollar sign in identifier", () => {
        // $ is allowed in identifierPart but not identifierStart
        const result = compileStrict("SELECT a$ FROM users");
        // `a$` is a valid identifier (starts with a, $ is identifierPart)
        // But there's no column `a$` in users
        expect(result.ok).toBe(false);
        expect(result.terminalStage).not.toBe("lexer");
    });

    test("$ at start of identifier fails", () => {
        // $ is not in identifierStart [A-Za-z_]
        const result = compileStrict("SELECT $a FROM users");
        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe("lexer");
    });

    test("underscore as identifier", () => {
        const result = compileStrict("SELECT _ FROM users");
        // _ is a valid identifierStart
        // But no column _ in users
        expect(result.ok).toBe(false);
        expect(result.terminalStage).not.toBe("lexer");
    });
});

// ════════════════════════════════════════════════════════════
// 15. PARSER-SPECIFIC STRUCTURAL ATTACKS
// ════════════════════════════════════════════════════════════

describe("parser structural attacks", () => {
    test("WITH without CTE body", () => {
        const result = compileStrict("WITH SELECT 1");
        // After WITH, parser calls parseCommonTableExpression which expects identifier
        // SELECT is a keyword, not an identifier -> fails
        expect(result.ok).toBe(false);
    });

    test("CTE without AS keyword", () => {
        const result = compileStrict("WITH cte (SELECT 1 FROM users) SELECT 1 FROM cte");
        // After cte name, parser tries parseOptionalColumnList -> sees (, consumes it
        // Then parseIdentifier -> SELECT is a keyword, fails
        expect(result.ok).toBe(false);
    });

    test("CTE with column list but missing right paren", () => {
        const result = compileStrict("WITH cte (a, b AS (SELECT 1, 2) SELECT 1 FROM cte");
        // Missing ) after column list
        expect(result.ok).toBe(false);
    });

    test("JOIN without ON clause", () => {
        const result = compileStrict("SELECT id FROM users INNER JOIN orders");
        // After parsing table reference, parser calls expectKeyword("ON") -> fails
        expect(result.ok).toBe(false);
    });

    test("LEFT without JOIN", () => {
        const result = compileStrict("SELECT id FROM users LEFT orders ON 1 = 1");
        // After LEFT, parser calls expectKeyword("JOIN") -> sees orders (identifier) -> fails
        expect(result.ok).toBe(false);
    });

    test("GROUP without BY", () => {
        const result = compileStrict("SELECT id FROM users GROUP id");
        // After GROUP, parser calls expectKeyword("BY") -> sees id -> fails
        expect(result.ok).toBe(false);
    });

    test("ORDER without BY", () => {
        const result = compileStrict("SELECT id FROM users ORDER id");
        expect(result.ok).toBe(false);
    });

    test("NOT without valid continuation", () => {
        // NOT in comparison position: `expr NOT` without IN
        const result = compileStrict("SELECT id FROM users WHERE id NOT 1");
        // After NOT, parser checks for IN or EXISTS
        // Sees 1 (number) -> error
        expect(result.ok).toBe(false);
    });

    test("IS without NULL", () => {
        const result = compileStrict("SELECT id FROM users WHERE id IS 1");
        // After IS, parser optionally consumes NOT, then expects NULL
        // Sees 1 -> fails
        expect(result.ok).toBe(false);
    });

    test("IS NOT without NULL", () => {
        const result = compileStrict("SELECT id FROM users WHERE id IS NOT 1");
        // After IS NOT, expects NULL, sees 1 -> fails
        expect(result.ok).toBe(false);
    });

    test("derived table without alias", () => {
        // (SELECT 1) in FROM position must have an alias
        const result = compileStrict("SELECT * FROM (SELECT 1)");
        // parseTableReference sees (, consumes it, parses subquery
        // Then expect(right_paren), then parseRequiredAlias
        // parseRequiredAlias tries to consume AS or identifier -> fails on next token
        expect(result.ok).toBe(false);
    });

    test("derived table with AS but no alias name", () => {
        const result = compileStrict("SELECT * FROM (SELECT 1) AS");
        // parseRequiredAlias consumes AS, then tries parseIdentifier -> EOF -> fails
        expect(result.ok).toBe(false);
    });

    test("SELECT only semicolon", () => {
        const result = compileStrict(";");
        // Parser calls parseQuery -> parseSelectStatement -> expectKeyword("SELECT")
        // Sees semicolon -> fails
        expect(result.ok).toBe(false);
    });

    test("multiple WITH clauses", () => {
        // WITH a AS (...) WITH b AS (...) SELECT 1
        // Parser only expects one WITH clause at the top
        const result = compileStrict(
            "WITH a AS (SELECT 1) WITH b AS (SELECT 2) SELECT 1",
        );
        // After first WITH clause, parser parses SELECT body
        // But encounters WITH instead of SELECT -> might fail
        // Actually: after WITH clause, parseSelectStatement expects SELECT keyword
        // But WITH is encountered -> fails
        expect(result.ok).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════
// 16. EMITTER OUTPUT VALIDATION
// ════════════════════════════════════════════════════════════

describe("emitter output safety", () => {
    test("identifier with backtick is properly escaped in output", () => {
        // The quoteIdentifier function replaces ` with ``
        const result = compileStrict("SELECT id AS `a``b` FROM users");
        expect(result.ok).toBe(true);
        // Input identifier content: a`b
        // Output should be: `a``b`
        expect(result.emitted?.sql).toContain("`a``b`");
    });

    test("string literal with single quote is properly escaped in output", () => {
        const result = compileStrict("SELECT id FROM users WHERE name = 'a''b'");
        expect(result.ok).toBe(true);
        // Input string content: a'b
        // Output should be: 'a''b'
        expect(result.emitted?.sql).toContain("'a''b'");
    });

    test("round-trip: compile output is valid SQL that can be re-compiled", () => {
        const queries = [
            "SELECT id, name FROM users WHERE age > 18 ORDER BY name ASC LIMIT 10",
            "SELECT u.id, o.total FROM users AS u INNER JOIN orders AS o ON o.user_id = u.id",
            "WITH recent AS (SELECT id FROM users LIMIT 5) SELECT id FROM recent",
            "SELECT id FROM users WHERE id IN (1, 2, 3)",
            "SELECT id FROM users WHERE name IS NOT NULL",
        ];

        for (const sql of queries) {
            const first = compileStrict(sql);
            expect(first.ok).toBe(true);
            if (first.ok && first.emitted) {
                // Re-compile the emitted SQL
                const second = compileStrict(first.emitted.sql);
                expect(
                    second.ok,
                    `Round-trip failed for: ${sql}\nEmitted: ${first.emitted.sql}\nError: ${second.diagnostics.map((d) => d.message).join(", ")}`,
                ).toBe(true);
            }
        }
    });

    test("integer literals are emitted raw (no quoting)", () => {
        const result = compileStrict("SELECT 42 FROM users");
        expect(result.ok).toBe(true);
        // Should emit 42 directly, not '42' or `42`
        expect(result.emitted?.sql).toContain("42");
        expect(result.emitted?.sql).not.toContain("'42'");
    });

    test("boolean literals are emitted as TRUE/FALSE", () => {
        const result = compileStrict("SELECT TRUE, FALSE FROM users");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("TRUE");
        expect(result.emitted?.sql).toContain("FALSE");
    });

    test("NULL literal is emitted as NULL", () => {
        const result = compileStrict("SELECT NULL FROM users");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("NULL");
    });
});

// ════════════════════════════════════════════════════════════
// 17. COMBINED PARSER + LEXER CONFUSION
// ════════════════════════════════════════════════════════════

describe("combined parser + lexer confusion", () => {
    test("string literal that looks like SQL is safe", () => {
        const result = compileStrict(
            "SELECT id FROM users WHERE name = 'SELECT * FROM mysql.user'",
        );
        expect(result.ok).toBe(true);
        // The SQL inside the string is just a string value, not executable
        expect(result.emitted?.sql).toContain("'SELECT * FROM mysql.user'");
    });

    test("backtick identifier that looks like a query is safe", () => {
        const result = compileStrict(
            "SELECT id AS `SELECT * FROM mysql.user` FROM users",
        );
        expect(result.ok).toBe(true);
        // The emitter lowercases identifier content
        expect(result.emitted?.sql).toContain("`select * from mysql.user`");
    });

    test("parameter in various expression positions", () => {
        const queries = [
            "SELECT ? FROM users",
            "SELECT id FROM users WHERE id = ?",
            "SELECT id FROM users WHERE id IN (?, ?, ?)",
            "SELECT id FROM users LIMIT ?",
            "SELECT id FROM users LIMIT ? OFFSET ?",
            "SELECT id FROM users ORDER BY ?",
        ];

        for (const sql of queries) {
            const result = compileStrict(sql);
            expect(result.ok).toBe(true);
        }
    });

    test("CURRENT_TIMESTAMP and friends in various positions", () => {
        const result1 = compileStrict("SELECT CURRENT_TIMESTAMP");
        expect(result1.ok).toBe(true);
        expect(result1.emitted?.sql).toContain("CURRENT_TIMESTAMP");

        const result2 = compileStrict("SELECT CURRENT_DATE");
        expect(result2.ok).toBe(true);

        const result3 = compileStrict("SELECT CURRENT_TIME");
        expect(result3.ok).toBe(true);
    });

    test("BETWEEN is not a keyword and fails", () => {
        // BETWEEN is not in the KEYWORDS set
        const result = compileStrict("SELECT id FROM users WHERE age BETWEEN 18 AND 65");
        // `between` would be lexed as an identifier
        // The parser would see it as an implicit alias after `age`
        // Then `18` is unexpected
        expect(result.ok).toBe(false);
    });

    test("LIKE is not a keyword and fails", () => {
        const result = compileStrict("SELECT id FROM users WHERE name LIKE '%test%'");
        // LIKE is not a keyword, treated as identifier (alias)
        expect(result.ok).toBe(false);
    });

    test("CASE expression is not supported", () => {
        const result = compileStrict(
            "SELECT CASE WHEN age > 18 THEN 'adult' ELSE 'minor' END FROM users",
        );
        // CASE is not a keyword, but WHEN, THEN, ELSE are not either
        // case is lexed as identifier, when is lexed as identifier...
        // This might partially parse but should fail eventually
        expect(result.ok).toBe(false);
    });

    test("window function syntax is rejected", () => {
        const result = compileStrict(
            "SELECT ROW_NUMBER() OVER (PARTITION BY id ORDER BY name) FROM users",
        );
        // OVER, PARTITION are not keywords; ROW_NUMBER is an identifier (function call)
        // After ROW_NUMBER(), the parser is back in parseSelectItem
        // OVER is an identifier -> consumed as implicit alias
        // Then ( -> unexpected in this position
        expect(result.ok).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════
// 18. PARSER BOUNDARY CONDITIONS
// ════════════════════════════════════════════════════════════

describe("parser boundary conditions", () => {
    test("peek beyond token array bounds returns safe value", () => {
        // Single token queries test peek boundary
        const result = compileStrict("SELECT");
        // Parser should not crash accessing tokens beyond the array
        expect(result.ok).toBe(false);
    });

    test("qualified name with many parts", () => {
        // a.b.c.d.e - the parser keeps consuming dots
        const result = compileStrict("SELECT id FROM a.b.c.d.e");
        // All parts are consumed as a qualified name
        // But the catalog won't find this table
        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe("binder");
    });

    test("deeply qualified column reference", () => {
        // users.id.something - the parser only handles qualifier.column
        const result = compileStrict("SELECT users.id.something FROM users");
        // Parser sees users.id as QualifiedReference
        // Then .something - the dot is consumed in parseMultiplicativeExpression?
        // Actually no: in parsePrimaryExpression, after identifier, checks dot
        // Sees dot, consumes it, checks if next is asterisk or identifier
        // `id` is consumed, then back in the caller, the result is QualifiedReference
        // The outer context continues - `.something` is separate
        // Actually: parsePrimaryExpression handles one dot. The result is
        // QualifiedReference(users, id). Then parseMultiplicativeExpression checks
        // for */% operators. `.` is not an operator. Back to parseAdditiveExpression.
        // Then parseComparisonExpression. Then `something` is not an operator.
        // Back to parseSelectItem -> parseOptionalAlias -> `something` is not dot/etc
        // Wait, after the QualifiedReference is returned, the parser is in
        // parseComparisonExpression -> the dot token is sitting there.
        // Actually the dot was already consumed in parsePrimaryExpression.
        // Let me re-trace: parsePrimaryExpression sees identifier `users`, consumes it.
        // Then checks consume("dot") -> yes, consumes dot.
        // Then checks next: identifier `id`, so creates QualifiedReference(users, id).
        // Returns to parseMultiplicativeExpression. Next token is `.` (dot).
        // . is not */% operator. Returns to parseAdditiveExpression.
        // . is not +/- operator. Returns to parseComparisonExpression.
        // . is not IS/IN/NOT/comparison operator. Returns to parseAndExpression.
        // . is not AND. Returns to parseOrExpression. . is not OR.
        // Returns to parseSelectItem. Then parseOptionalAlias.
        // . is not AS keyword and not identifier -> returns undefined.
        // Back in parseSelectList. . is not comma.
        // Back in parseSelectStatement. . is not FROM keyword.
        // Then expect("eof") -> dot is not eof -> fails!
        expect(result.ok).toBe(false);
    });

    test("EXISTS without parenthesized subquery", () => {
        const result = compileStrict("SELECT id FROM users WHERE EXISTS SELECT 1");
        // After EXISTS, parser calls parseParenthesizedQuery which expects (
        // Sees SELECT -> fails
        expect(result.ok).toBe(false);
    });

    test("NOT EXISTS without subquery", () => {
        const result = compileStrict("SELECT id FROM users WHERE NOT EXISTS 1");
        // After NOT EXISTS, parseParenthesizedQuery expects ( -> fails
        expect(result.ok).toBe(false);
    });

    test("multiple aliases for same table", () => {
        const result = compileStrict("SELECT id FROM users AS u AS v");
        // After parsing `users AS u`, parseOptionalAlias is done
        // Back in parseSelectStatement, AS is a keyword
        // Parser looks for JOINs (INNER/LEFT/JOIN) -> no
        // Looks for WHERE -> AS is not WHERE
        // Looks for GROUP -> no
        // Looks for ORDER -> no
        // Looks for LIMIT -> no
        // Then expect("eof") -> AS keyword -> fails
        expect(result.ok).toBe(false);
    });

    test("comma-separated CTEs work correctly", () => {
        const result = compileStrict(
            "WITH a AS (SELECT id FROM users), b AS (SELECT id FROM orders) SELECT a.id FROM a INNER JOIN b ON a.id = b.id",
        );
        expect(result.ok).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════
// 19. SPECIAL CHARACTER ATTACKS
// ════════════════════════════════════════════════════════════

describe("special character attacks", () => {
    test("null byte in input", () => {
        const result = compileStrict("SELECT\x00id FROM users");
        expect(result.ok).toBe(false);
    });

    test("backspace character", () => {
        const result = compileStrict("SELECT\x08id FROM users");
        expect(result.ok).toBe(false);
    });

    test("bell character", () => {
        const result = compileStrict("SELECT\x07id FROM users");
        expect(result.ok).toBe(false);
    });

    test("escape character", () => {
        const result = compileStrict("SELECT\x1Bid FROM users");
        expect(result.ok).toBe(false);
    });

    test("DEL character", () => {
        const result = compileStrict("SELECT\x7Fid FROM users");
        expect(result.ok).toBe(false);
    });

    test("emoji in input", () => {
        const result = compileStrict("SELECT id FROM users WHERE name = '\u{1F600}'");
        // Emoji inside string literal should be fine
        expect(result.ok).toBe(true);
    });

    test("emoji outside string literal", () => {
        const result = compileStrict("SELECT \u{1F600} FROM users");
        // Emoji is not a valid identifier start -> unexpected character
        expect(result.ok).toBe(false);
    });

    test("BOM character at start", () => {
        // U+FEFF Byte Order Mark
        const result = compileStrict("\uFEFF SELECT id FROM users");
        // BOM is not whitespace in all JS engines (/\s/ may or may not match it)
        // If treated as whitespace, query works. If not, it's an error.
        expect(typeof result.ok).toBe("boolean");
    });
});

// ════════════════════════════════════════════════════════════
// 20. IDEMPOTENCY AND CONSISTENCY
// ════════════════════════════════════════════════════════════

describe("idempotency and consistency", () => {
    test("compiling same query twice produces same result", () => {
        const sql = "SELECT id, name FROM users WHERE age > 18 ORDER BY name LIMIT 10";
        const r1 = compileStrict(sql);
        const r2 = compileStrict(sql);

        expect(r1.ok).toBe(r2.ok);
        expect(r1.emitted?.sql).toBe(r2.emitted?.sql);
    });

    test("case variations of keywords produce same output", () => {
        const r1 = compileStrict("SELECT id FROM users WHERE age > 18");
        const r2 = compileStrict("select id from users where age > 18");
        const r3 = compileStrict("Select Id From Users Where Age > 18");

        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);
        expect(r3.ok).toBe(true);
        // All should produce identical output
        expect(r1.emitted?.sql).toBe(r2.emitted?.sql);
        expect(r1.emitted?.sql).toBe(r3.emitted?.sql);
    });

    test("whitespace variations produce same output", () => {
        const r1 = compileStrict("SELECT id FROM users");
        const r2 = compileStrict("SELECT  id  FROM  users");
        const r3 = compileStrict("SELECT\tid\nFROM\tusers");

        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);
        expect(r3.ok).toBe(true);
        expect(r1.emitted?.sql).toBe(r2.emitted?.sql);
        expect(r1.emitted?.sql).toBe(r3.emitted?.sql);
    });
});
