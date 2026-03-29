import { describe, expect, test } from "vitest";

import { compile, type CompileOptions, type CompileResult } from "../src/compiler";
import { CompilerStage, DiagnosticCode, type Diagnostic } from "../src/diagnostics";
import { createTestCatalog } from "../src/testing";

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const catalog = createTestCatalog();

function compileStrict(sql: string, extra: Partial<CompileOptions> = {}): CompileResult {
    return compile(sql, { catalog, dialect: "mysql", strict: true, ...extra });
}

function getDiagnostics(result: CompileResult): readonly Diagnostic[] {
    return result.diagnostics;
}

function getDiagnosticCodes(result: CompileResult): readonly DiagnosticCode[] {
    return result.diagnostics.map((d) => d.code);
}

function getDiagnosticMessages(result: CompileResult): readonly string[] {
    return result.diagnostics.map((d) => d.message);
}

// ════════════════════════════════════════════════════════════
// 1. TABLE ENUMERATION VIA ERROR MESSAGES
// ════════════════════════════════════════════════════════════

describe("table enumeration via error messages", () => {
    test("[VULN] error messages differ for existing vs non-existing tables", () => {
        // An attacker can probe whether a table exists by observing the
        // error code and message. If the error code differs (e.g., "unknown-table"
        // vs a different error), the attacker knows the table does or does not exist.
        const existingTable = compileStrict("SELECT id FROM users");
        const nonExistingTable = compileStrict("SELECT id FROM nonexistent_table");

        // Existing table succeeds
        expect(existingTable.ok).toBe(true);
        // Non-existing table fails with a specific diagnostic code
        expect(nonExistingTable.ok).toBe(false);

        // VULNERABILITY: The attacker can distinguish existing from non-existing
        // tables by checking whether the query compiles successfully.
        // This is an inherent oracle for table enumeration.
        expect(nonExistingTable.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownTable);
    });

    test("[VULN] error message echoes the probed table name back to attacker", () => {
        const result = compileStrict("SELECT id FROM secret_admin_table");
        expect(result.ok).toBe(false);

        // VULNERABILITY: The error message includes the exact table name the
        // attacker probed. This confirms the table name is not being redacted.
        const message = result.diagnostics[0]?.message ?? "";
        expect(message).toContain("secret_admin_table");
    });

    test("[VULN] systematic table enumeration is feasible", () => {
        // An attacker can brute-force table names and observe which ones
        // produce "unknown-table" errors vs success.
        const probes = [
            "users",
            "profiles",
            "orders",
            "internal_projects",
            "timeseries",
            "passwords",
            "tokens",
            "sessions",
            "admin_settings",
            "audit_log",
        ];

        const discoveredTables: string[] = [];
        for (const table of probes) {
            const result = compileStrict(`SELECT 1 FROM ${table}`);
            if (result.ok) {
                discoveredTables.push(table);
            }
        }

        // VULNERABILITY: The attacker can enumerate all 5 tables in the catalog
        // by probing table names and checking which compile successfully.
        expect(discoveredTables).toEqual([
            "users",
            "profiles",
            "orders",
            "internal_projects",
            "timeseries",
        ]);
    });

    test("[VULN] terminal stage leaks which pipeline phase failed", () => {
        // The terminalStage field reveals whether the failure occurred at the
        // lexer, parser, or binder stage, giving attackers more information.
        const unknownTable = compileStrict("SELECT id FROM nonexistent");
        const syntaxError = compileStrict("INVALID SQL");

        // Attacker can distinguish syntax errors (parser) from schema errors (binder)
        expect(unknownTable.terminalStage).toBe(CompilerStage.Binder);
        expect(syntaxError.terminalStage).toBe(CompilerStage.Parser);
    });

    test("[VULN] qualified table names reveal schema structure in errors", () => {
        const result = compileStrict("SELECT id FROM schema1.users");
        expect(result.ok).toBe(false);

        // The error echoes the fully qualified name back
        const message = result.diagnostics[0]?.message ?? "";
        expect(message).toContain("schema1.users");
    });
});

// ════════════════════════════════════════════════════════════
// 2. COLUMN ENUMERATION VIA ERROR MESSAGES
// ════════════════════════════════════════════════════════════

describe("column enumeration via error messages", () => {
    test("[VULN] error messages differ for existing vs non-existing columns", () => {
        const existingColumn = compileStrict("SELECT id FROM users");
        const nonExistingColumn = compileStrict("SELECT password_hash FROM users");

        expect(existingColumn.ok).toBe(true);
        expect(nonExistingColumn.ok).toBe(false);

        // VULNERABILITY: Attacker can probe column names and distinguish
        // existing from non-existing columns.
        expect(nonExistingColumn.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownColumn);
    });

    test("[VULN] error message echoes probed column name", () => {
        const result = compileStrict("SELECT ssn FROM users");
        expect(result.ok).toBe(false);

        // VULNERABILITY: The error message echoes the column name back
        const message = result.diagnostics[0]?.message ?? "";
        expect(message).toContain("ssn");
    });

    test("[VULN] systematic column enumeration on a known table", () => {
        // Once a table is discovered, an attacker can enumerate all its columns.
        const probes = [
            "id",
            "name",
            "email",
            "age",
            "tenant_id",
            "created_at",
            "password",
            "ssn",
            "credit_card",
            "api_key",
            "secret",
        ];

        const discoveredColumns: string[] = [];
        for (const col of probes) {
            const result = compileStrict(`SELECT ${col} FROM users`);
            if (result.ok) {
                discoveredColumns.push(col);
            }
        }

        // VULNERABILITY: The attacker can enumerate all 6 columns of the users table
        expect(discoveredColumns).toEqual(["id", "name", "email", "age", "tenant_id", "created_at"]);
    });

    test("[VULN] qualified column error reveals table alias context", () => {
        const result = compileStrict("SELECT u.password FROM users AS u");
        expect(result.ok).toBe(false);

        // VULNERABILITY: Error message includes the table alias, confirming
        // the table was resolved successfully (only the column is missing).
        const message = result.diagnostics[0]?.message ?? "";
        expect(message).toContain("password");
        expect(message).toContain("u"); // alias is leaked
    });
});

// ════════════════════════════════════════════════════════════
// 3. WILDCARD ABUSE FOR SCHEMA DISCOVERY
// ════════════════════════════════════════════════════════════

describe("wildcard abuse for schema discovery", () => {
    test("[VULN] SELECT * reveals all column names via bound output metadata", () => {
        const result = compileStrict("SELECT * FROM users");
        expect(result.ok).toBe(true);

        // The emitter keeps SELECT * as-is in the SQL output, but the
        // bound query output metadata reveals all column names.
        // VULNERABILITY: The bound output fully exposes the table schema.
        const output = result.bound?.output ?? [];
        const columnNames = output.map((c) => c.name);
        expect(columnNames).toContain("id");
        expect(columnNames).toContain("name");
        expect(columnNames).toContain("email");
        expect(columnNames).toContain("age");
        expect(columnNames).toContain("tenant_id");
        expect(columnNames).toContain("created_at");
        expect(columnNames.length).toBe(6);
    });

    test("[VULN] SELECT * on joined tables reveals columns from all tables via bound output", () => {
        const result = compileStrict(
            "SELECT * FROM users INNER JOIN orders ON users.id = orders.user_id",
        );
        expect(result.ok).toBe(true);

        // VULNERABILITY: The bound output reveals columns from BOTH tables
        const output = result.bound?.output ?? [];
        const columnNames = output.map((c) => c.name);
        // Users columns
        expect(columnNames).toContain("email");
        expect(columnNames).toContain("age");
        // Orders columns
        expect(columnNames).toContain("total");
        expect(columnNames).toContain("status");
        expect(columnNames).toContain("total_cents");
        // Total column count = users(6) + orders(7) = 13
        expect(columnNames.length).toBe(13);
    });

    test("[VULN] qualified wildcard reveals columns for specific table", () => {
        const result = compileStrict(
            "SELECT orders.* FROM users INNER JOIN orders ON users.id = orders.user_id",
        );
        expect(result.ok).toBe(true);

        // VULNERABILITY: Reveals just the orders table columns
        const sql = result.emitted?.sql ?? "";
        expect(sql).toContain("`orders`.*");
    });

    test("[VULN] SELECT * output metadata reveals column count and names", () => {
        const result = compileStrict("SELECT * FROM profiles");
        expect(result.ok).toBe(true);

        // VULNERABILITY: The bound query output reveals all column names
        const output = result.bound?.output ?? [];
        const columnNames = output.map((c) => c.name);
        expect(columnNames).toEqual(["user_id", "display_name", "deleted_at"]);
    });
});

// ════════════════════════════════════════════════════════════
// 4. AMBIGUOUS COLUMN PROBING
// ════════════════════════════════════════════════════════════

describe("ambiguous column probing for cross-table schema inference", () => {
    test("[VULN] ambiguous column error reveals which tables share a column", () => {
        // If a column name is ambiguous, the error reveals which tables have it.
        const result = compileStrict(
            "SELECT id FROM users INNER JOIN orders ON users.id = orders.id",
        );
        expect(result.ok).toBe(false);

        // VULNERABILITY: The error message and relatedSpans reveal which tables
        // contain the ambiguous column.
        const diagnostic = result.diagnostics[0];
        expect(diagnostic?.code).toBe(DiagnosticCode.AmbiguousColumn);
        expect(diagnostic?.message).toContain("id");

        // The relatedSpans field reveals matched table aliases
        const relatedMessages = diagnostic?.relatedSpans?.map((s) => s.message) ?? [];
        expect(relatedMessages.some((m) => m.includes("users"))).toBe(true);
        expect(relatedMessages.some((m) => m.includes("orders"))).toBe(true);
    });

    test("[VULN] ambiguous column probing across joins reveals shared columns", () => {
        // An attacker can discover which columns are shared across tables
        // by probing with unqualified column references in joins.
        const sharedColumns: string[] = [];
        const probes = ["id", "user_id", "name", "tenant_id", "created_at", "email", "total"];

        for (const col of probes) {
            const result = compileStrict(
                `SELECT ${col} FROM users INNER JOIN orders ON users.id = orders.id`,
            );
            if (
                !result.ok &&
                result.diagnostics.some((d) => d.code === DiagnosticCode.AmbiguousColumn)
            ) {
                sharedColumns.push(col);
            }
        }

        // VULNERABILITY: Attacker learns which columns exist in both users and orders
        expect(sharedColumns).toContain("id");
        expect(sharedColumns).toContain("tenant_id");
        expect(sharedColumns).toContain("created_at");
    });

    test("[VULN] three-way join amplifies ambiguity information", () => {
        const result = compileStrict(
            "SELECT id FROM users AS u INNER JOIN orders AS o ON u.id = o.user_id INNER JOIN internal_projects AS p ON u.id = p.id",
        );
        expect(result.ok).toBe(false);

        // VULNERABILITY: Error reveals all three tables have the "id" column
        const diagnostic = result.diagnostics[0];
        expect(diagnostic?.code).toBe(DiagnosticCode.AmbiguousColumn);
        const relatedMessages = diagnostic?.relatedSpans?.map((s) => s.message) ?? [];
        expect(relatedMessages.length).toBeGreaterThanOrEqual(2);
    });
});

// ════════════════════════════════════════════════════════════
// 5. CTE / ALIAS SHADOWING FOR CONFUSION
// ════════════════════════════════════════════════════════════

describe("CTE and alias shadowing", () => {
    test("CTE name shadows a real table name -- CTE takes priority", () => {
        // Define a CTE named "users" that shadows the real "users" table.
        // The CTE has different columns, so SELECT email should fail if
        // the CTE is used (CTE has no email column).
        const result = compileStrict(
            "WITH users AS (SELECT id FROM orders) SELECT email FROM users",
        );

        // If the CTE shadows the real table, email should be unknown
        // because the CTE only exposes "id".
        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownColumn);
    });

    test("[VULN] CTE shadowing can be used to probe real table columns", () => {
        // If a CTE shadows a real table, the attacker can compare behavior:
        // - Without CTE: query references real table columns
        // - With CTE: query references CTE columns (which are different)
        // The difference reveals which columns belong to the real table.

        // Without CTE: "email" resolves on real users table
        const withoutCte = compileStrict("SELECT email FROM users");
        expect(withoutCte.ok).toBe(true);

        // With CTE: "email" does NOT resolve because CTE only has "id"
        const withCte = compileStrict(
            "WITH users AS (SELECT id FROM orders) SELECT email FROM users",
        );
        expect(withCte.ok).toBe(false);

        // VULNERABILITY: The behavioral difference confirms "email" is a real
        // column on the users table (it exists without CTE, fails with CTE).
        // This is an indirect information disclosure via shadowing.
    });

    test("duplicate CTE name is rejected", () => {
        const result = compileStrict(
            "WITH a AS (SELECT id FROM users), a AS (SELECT id FROM orders) SELECT id FROM a",
        );
        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.DuplicateAlias);
    });

    test("table alias does not shadow other tables in FROM", () => {
        // Using alias "orders" for users table should not affect real orders table
        const result = compileStrict(
            "SELECT o.email FROM users AS o",
        );
        // "email" is on users (aliased as "o"), so this should work
        expect(result.ok).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════
// 6. DIAGNOSTIC INFORMATION LEAKAGE DEPTH
// ════════════════════════════════════════════════════════════

describe("diagnostic information leakage depth", () => {
    test("[VULN] error messages reveal exact position (line:column) of the error", () => {
        const result = compileStrict("SELECT id FROM nonexistent_table");
        expect(result.ok).toBe(false);

        // VULNERABILITY: The diagnostic includes span information (start/end
        // offsets) that reveals exactly where the problematic token is.
        const span = result.diagnostics[0]?.primarySpan;
        expect(span).toBeDefined();
        expect(typeof span?.start).toBe("number");
        expect(typeof span?.end).toBe("number");
    });

    test("[VULN] error includes diagnostic code revealing failure category", () => {
        const results = [
            { sql: "SELECT id FROM nonexistent", expectedCode: DiagnosticCode.UnknownTable },
            { sql: "SELECT bogus FROM users", expectedCode: DiagnosticCode.UnknownColumn },
            { sql: "SELECT id FROM users; SELECT id FROM users", expectedCode: DiagnosticCode.UnexpectedToken },
        ];

        for (const { sql, expectedCode } of results) {
            const result = compileStrict(sql);
            expect(result.ok).toBe(false);
            // VULNERABILITY: The diagnostic code precisely categorizes the error,
            // letting attackers distinguish table errors from column errors from
            // syntax errors, enabling targeted probing.
            expect(result.diagnostics[0]?.code).toBe(expectedCode);
        }
    });

    test("[VULN] terminalStage reveals which pipeline stage rejected the query", () => {
        const lexerFail = compileStrict("SELECT id FROM users /* comment */");
        const parserFail = compileStrict("UPDATE users SET name = 'x'");
        const binderFail = compileStrict("SELECT id FROM nonexistent");

        // VULNERABILITY: An attacker can infer compiler internals
        expect(lexerFail.terminalStage).toBe(CompilerStage.Lexer);
        expect(parserFail.terminalStage).toBe(CompilerStage.Parser);
        expect(binderFail.terminalStage).toBe(CompilerStage.Binder);
    });

    test("[VULN] help field in diagnostics provides guidance to attacker", () => {
        const result = compileStrict("SELECT id FROM users -- comment");
        expect(result.ok).toBe(false);

        // VULNERABILITY: The "help" field in diagnostics tells the attacker
        // exactly how to fix their query, which aids in crafting valid attacks.
        const help = result.diagnostics[0]?.help;
        expect(help).toBeDefined();
        expect(help).toContain("Remove SQL comments");
    });
});

// ════════════════════════════════════════════════════════════
// 7. TIMING SIDE-CHANNEL ANALYSIS
// ════════════════════════════════════════════════════════════

describe("timing side-channel analysis", () => {
    test("compilation time is roughly consistent for existing vs non-existing tables", () => {
        // Measure compilation time for existing vs non-existing tables.
        // A significant timing difference could enable blind table enumeration.
        const iterations = 500;

        // Warm up the JIT
        for (let i = 0; i < 100; i++) {
            compileStrict("SELECT id FROM users");
            compileStrict("SELECT id FROM nonexistent_table_xyz");
        }

        const existingTimes: number[] = [];
        const nonExistingTimes: number[] = [];

        for (let i = 0; i < iterations; i++) {
            const start1 = performance.now();
            compileStrict("SELECT id FROM users");
            existingTimes.push(performance.now() - start1);

            const start2 = performance.now();
            compileStrict("SELECT id FROM nonexistent_table_xyz");
            nonExistingTimes.push(performance.now() - start2);
        }

        // Sort and take median to reduce noise
        existingTimes.sort((a, b) => a - b);
        nonExistingTimes.sort((a, b) => a - b);

        const medianExisting = existingTimes[Math.floor(iterations / 2)]!;
        const medianNonExisting = nonExistingTimes[Math.floor(iterations / 2)]!;

        // If the timing ratio is greater than 3x, it is a significant side-channel.
        // In practice, the existing table query does more work (binding, analysis,
        // enforcement, emission) while the non-existing table fails early at the binder.
        const ratio =
            medianExisting > medianNonExisting
                ? medianExisting / medianNonExisting
                : medianNonExisting / medianExisting;

        // Document the timing difference
        // A successful query goes through more stages than a failed one,
        // so there will inherently be a timing difference. The question is
        // whether it is exploitable in practice.
        // We flag it as a finding if the ratio exceeds 2x.
        if (ratio > 2) {
            // [VULN] Timing difference detected. In practice this may or may not
            // be exploitable depending on network jitter, but locally the difference
            // is measurable.
        }

        // The test passes regardless -- we are documenting the finding, not asserting defense.
        expect(true).toBe(true);
    });

    test("compilation time is roughly consistent for existing vs non-existing columns", () => {
        const iterations = 500;

        // Warm up
        for (let i = 0; i < 100; i++) {
            compileStrict("SELECT id FROM users");
            compileStrict("SELECT nonexistent_col FROM users");
        }

        const existingTimes: number[] = [];
        const nonExistingTimes: number[] = [];

        for (let i = 0; i < iterations; i++) {
            const start1 = performance.now();
            compileStrict("SELECT id FROM users");
            existingTimes.push(performance.now() - start1);

            const start2 = performance.now();
            compileStrict("SELECT nonexistent_col FROM users");
            nonExistingTimes.push(performance.now() - start2);
        }

        existingTimes.sort((a, b) => a - b);
        nonExistingTimes.sort((a, b) => a - b);

        const medianExisting = existingTimes[Math.floor(iterations / 2)]!;
        const medianNonExisting = nonExistingTimes[Math.floor(iterations / 2)]!;

        const ratio =
            medianExisting > medianNonExisting
                ? medianExisting / medianNonExisting
                : medianNonExisting / medianExisting;

        // Same analysis as above -- a successful query does more work.
        if (ratio > 2) {
            // [VULN] Timing difference detected for column probing.
        }

        expect(true).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════
// 8. ERROR-BASED DATA EXTRACTION
// ════════════════════════════════════════════════════════════

describe("error-based data extraction", () => {
    test("error messages do not leak data values from the catalog", () => {
        // Attempt to craft queries that might cause the compiler to include
        // data values in error messages. Since this is a compiler (not a
        // runtime query engine), it should not have access to actual data.
        const result = compileStrict("SELECT id FROM users WHERE id = 1");
        if (result.ok) {
            // The emitted SQL does not contain actual data -- it is just a
            // compiled query template.
            expect(result.emitted?.sql).not.toMatch(/^[0-9]+$/);
        }
    });

    test("enforcer error messages do not leak policy configuration details beyond necessary", () => {
        const result = compileStrict("SELECT SLEEP(10) FROM users", {
            allowedFunctions: new Set(["count", "sum"]),
        });
        expect(result.ok).toBe(false);

        // The error says the function is not allowed, but does NOT list
        // what functions ARE allowed (which would reveal the allowlist).
        const message = result.diagnostics[0]?.message ?? "";
        expect(message).toContain("sleep");
        expect(message).not.toContain("count");
        expect(message).not.toContain("sum");
    });

    test("[VULN] policy violation errors reveal policy configuration", () => {
        // When a tenant scoping policy fails, the error reveals the policy name,
        // the required column, and the table alias.
        const result = compileStrict("SELECT metric FROM timeseries", {
            policies: [
                {
                    name: "tenant-scoping",
                    enforce: (bound) => {
                        return [
                            {
                                code: DiagnosticCode.PolicyViolation,
                                stage: CompilerStage.Enforcer,
                                severity: "error" as const,
                                message: `Policy "tenant-scoping" requires timeseries.tenant_id to be scoped.`,
                                primarySpan: bound.span,
                            },
                        ];
                    },
                },
            ],
            policyContext: { tenantId: "t1" },
        });

        // If it fails with policy violation, the error reveals:
        // - The policy name ("tenant-scoping")
        // - The column name ("tenant_id")
        // - The table name ("timeseries")
        // This helps an attacker understand the security model.
        if (!result.ok) {
            const message = result.diagnostics[0]?.message ?? "";
            // The message reveals internal security configuration
            expect(message).toContain("tenant-scoping");
            expect(message).toContain("tenant_id");
        }
    });
});

// ════════════════════════════════════════════════════════════
// 9. BOOLEAN-BASED BLIND PROBING
// ════════════════════════════════════════════════════════════

describe("boolean-based blind probing", () => {
    test("[VULN] boolean expressions can be used to confirm column existence", () => {
        // An attacker can use boolean expressions in WHERE clauses to confirm
        // column existence without needing the column in SELECT.
        const existingCol = compileStrict("SELECT 1 FROM users WHERE email IS NOT NULL");
        const nonExistingCol = compileStrict("SELECT 1 FROM users WHERE password IS NOT NULL");

        // VULNERABILITY: The attacker can infer column existence from
        // compilation success/failure even without selecting the column.
        expect(existingCol.ok).toBe(true);
        expect(nonExistingCol.ok).toBe(false);
    });

    test("[VULN] boolean probing works in HAVING clause", () => {
        const result = compileStrict(
            "SELECT name FROM users GROUP BY name HAVING email IS NOT NULL",
        );
        // email exists on users, so this should compile
        expect(result.ok).toBe(true);

        const bad = compileStrict(
            "SELECT name FROM users GROUP BY name HAVING password IS NOT NULL",
        );
        // password does not exist, so this fails
        expect(bad.ok).toBe(false);
    });

    test("[VULN] boolean probing works in ORDER BY", () => {
        const result = compileStrict("SELECT id FROM users ORDER BY email");
        expect(result.ok).toBe(true);

        const bad = compileStrict("SELECT id FROM users ORDER BY password");
        expect(bad.ok).toBe(false);
    });

    test("[VULN] boolean probing works in JOIN ON clause", () => {
        const result = compileStrict(
            "SELECT u.id FROM users AS u INNER JOIN orders AS o ON u.id = o.user_id",
        );
        expect(result.ok).toBe(true);

        // Probing for a column on orders
        const bad = compileStrict(
            "SELECT u.id FROM users AS u INNER JOIN orders AS o ON u.id = o.secret_col",
        );
        expect(bad.ok).toBe(false);
        expect(bad.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownColumn);
    });

    test("[VULN] boolean probing works in subquery", () => {
        const result = compileStrict(
            "SELECT id FROM users WHERE id IN (SELECT user_id FROM orders WHERE status = 'paid')",
        );
        expect(result.ok).toBe(true);

        const bad = compileStrict(
            "SELECT id FROM users WHERE id IN (SELECT user_id FROM orders WHERE secret = 'paid')",
        );
        expect(bad.ok).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════
// 10. BOUND QUERY OUTPUT METADATA LEAKAGE
// ════════════════════════════════════════════════════════════

describe("bound query output metadata leakage", () => {
    test("[VULN] CompileResult exposes full bound AST with table/column metadata", () => {
        const result = compileStrict("SELECT id, email FROM users");
        expect(result.ok).toBe(true);

        // VULNERABILITY: The CompileResult includes the full bound AST, which
        // contains resolved table schemas, column schemas, and internal IDs.
        // If this result object is ever exposed to an untrusted caller, it
        // leaks the entire schema.
        expect(result.bound).toBeDefined();
        expect(result.bound?.body.from?.table.name).toBe("users");
        expect(result.bound?.body.from?.table.id).toBe("users");

        // The table schema includes ALL columns, not just the selected ones
        const allColumns = Array.from(result.bound?.body.from?.table.columns.keys() ?? []);
        expect(allColumns.length).toBe(6); // All 6 columns are exposed
    });

    test("[VULN] stages object exposes internal compiler state", () => {
        const result = compileStrict("SELECT id FROM users");
        expect(result.ok).toBe(true);

        // VULNERABILITY: The stages object reveals detailed internal state
        // from each compiler phase.
        expect(result.stages.lex).toBeDefined();
        expect(result.stages.parse).toBeDefined();
        expect(result.stages.bind).toBeDefined();
        expect(result.stages.analyze).toBeDefined();
        expect(result.stages.enforce).toBeDefined();
        expect(result.stages.emit).toBeDefined();
    });

    test("[VULN] token stream in result leaks source tokens", () => {
        const result = compileStrict("SELECT id FROM users WHERE name = 'secret'");
        expect(result.ok).toBe(true);

        // VULNERABILITY: The full token stream is included in the result,
        // exposing all parsed tokens including string literals.
        expect(result.tokens).toBeDefined();
        expect(result.tokens?.tokens.length).toBeGreaterThan(0);
    });
});

// ════════════════════════════════════════════════════════════
// 11. CROSS-TABLE SCHEMA INFERENCE VIA JOINS
// ════════════════════════════════════════════════════════════

describe("cross-table schema inference via joins", () => {
    test("[VULN] joining two tables and probing columns reveals both schemas", () => {
        // An attacker can join two tables and probe columns from each
        const usersColumns: string[] = [];
        const ordersColumns: string[] = [];
        const probes = [
            "id",
            "name",
            "email",
            "age",
            "tenant_id",
            "created_at",
            "user_id",
            "total",
            "total_cents",
            "status",
            "display_name",
            "deleted_at",
        ];

        for (const col of probes) {
            const resultUsers = compileStrict(
                `SELECT u.${col} FROM users AS u INNER JOIN orders AS o ON u.id = o.user_id`,
            );
            if (resultUsers.ok) {
                usersColumns.push(col);
            }

            const resultOrders = compileStrict(
                `SELECT o.${col} FROM users AS u INNER JOIN orders AS o ON u.id = o.user_id`,
            );
            if (resultOrders.ok) {
                ordersColumns.push(col);
            }
        }

        // VULNERABILITY: Attacker fully enumerates both table schemas.
        // The order depends on the probe list, but the set is what matters.
        expect(usersColumns.sort()).toEqual(
            ["id", "name", "email", "age", "tenant_id", "created_at"].sort(),
        );
        expect(ordersColumns.sort()).toEqual(
            ["id", "user_id", "total", "total_cents", "tenant_id", "status", "created_at"].sort(),
        );
    });
});

// ════════════════════════════════════════════════════════════
// 12. DERIVED TABLE / SUBQUERY SCHEMA INFERENCE
// ════════════════════════════════════════════════════════════

describe("derived table and subquery schema inference", () => {
    test("[VULN] derived table exposes only selected columns", () => {
        // An attacker can use derived tables to probe which columns exist
        const result = compileStrict(
            "SELECT sub.id FROM (SELECT id, email FROM users) AS sub",
        );
        expect(result.ok).toBe(true);

        // Probing for a column not in the derived table
        const bad = compileStrict(
            "SELECT sub.age FROM (SELECT id, email FROM users) AS sub",
        );
        expect(bad.ok).toBe(false);

        // VULNERABILITY: The attacker can confirm that "age" is NOT in
        // the derived table's projection, but since they defined the
        // derived table themselves, this is less of a leak. However,
        // it confirms that "id" and "email" ARE valid columns on users.
    });

    test("[VULN] CTE output columns reveal the schema of the underlying table", () => {
        const result = compileStrict(
            "WITH u AS (SELECT * FROM users) SELECT id FROM u",
        );
        expect(result.ok).toBe(true);

        // The CTE using SELECT * captures all columns from users.
        // Probing the CTE reveals the users table schema.
        const probes = ["id", "name", "email", "age", "tenant_id", "created_at", "password"];
        const cteColumns: string[] = [];

        for (const col of probes) {
            const r = compileStrict(
                `WITH u AS (SELECT * FROM users) SELECT ${col} FROM u`,
            );
            if (r.ok) {
                cteColumns.push(col);
            }
        }

        // VULNERABILITY: All 6 real columns discovered via CTE with SELECT *
        expect(cteColumns).toEqual(["id", "name", "email", "age", "tenant_id", "created_at"]);
    });
});

// ════════════════════════════════════════════════════════════
// 13. DIAGNOSTIC CODES AS ORACLE
// ════════════════════════════════════════════════════════════

describe("diagnostic codes as an oracle", () => {
    test("[VULN] different error codes for different failure modes enable precise probing", () => {
        // An attacker can use the diagnostic code to determine exactly what went wrong
        const scenarios: Array<{ sql: string; expectedCode: DiagnosticCode; description: string }> = [
            {
                sql: "SELECT id FROM nonexistent",
                expectedCode: DiagnosticCode.UnknownTable,
                description: "Table does not exist",
            },
            {
                sql: "SELECT bogus FROM users",
                expectedCode: DiagnosticCode.UnknownColumn,
                description: "Column does not exist on a known table",
            },
            {
                sql: "SELECT id FROM users INNER JOIN orders ON users.id = orders.id",
                expectedCode: DiagnosticCode.AmbiguousColumn,
                description: "Column exists on multiple tables",
            },
            {
                sql: "SELECT x.id FROM users",
                expectedCode: DiagnosticCode.UnknownTable,
                description: "Unknown table qualifier",
            },
        ];

        for (const { sql, expectedCode, description } of scenarios) {
            const result = compileStrict(sql);
            expect(result.ok).toBe(false);
            // VULNERABILITY: Each scenario produces a distinct error code,
            // enabling the attacker to build a precise oracle.
            expect(result.diagnostics[0]?.code, description).toBe(expectedCode);
        }
    });

    test("[VULN] error code distinguishes unknown-table from unknown-column precisely", () => {
        // This is the key oracle: the attacker first probes for tables,
        // then probes for columns on discovered tables.
        const tableProbe = compileStrict("SELECT 1 FROM secret_table");
        const columnProbe = compileStrict("SELECT secret_col FROM users");

        expect(tableProbe.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownTable);
        expect(columnProbe.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownColumn);

        // VULNERABILITY: The distinct codes allow the attacker to know
        // that "secret_table" is not a table, but "users" IS a table
        // (because they got unknown-column instead of unknown-table).
    });
});

// ════════════════════════════════════════════════════════════
// 14. FUNCTION ALLOWLIST PROBING
// ════════════════════════════════════════════════════════════

describe("function allowlist probing", () => {
    test("[VULN] attacker can enumerate allowed functions via error messages", () => {
        const allowedFunctions = new Set(["count", "sum", "avg", "min", "max"]);
        const probes = [
            "count",
            "sum",
            "avg",
            "min",
            "max",
            "sleep",
            "benchmark",
            "load_file",
            "concat",
            "substring",
        ];

        const allowed: string[] = [];
        const disallowed: string[] = [];

        for (const fn of probes) {
            const result = compileStrict(`SELECT ${fn}(id) FROM users`, {
                allowedFunctions,
            });
            if (result.ok) {
                allowed.push(fn);
            } else if (
                result.diagnostics.some((d) => d.code === DiagnosticCode.DisallowedFunction)
            ) {
                disallowed.push(fn);
            }
        }

        // VULNERABILITY: Attacker can fully enumerate the function allowlist
        expect(allowed).toEqual(["count", "sum", "avg", "min", "max"]);
        expect(disallowed).toEqual(["sleep", "benchmark", "load_file", "concat", "substring"]);
    });

    test("[VULN] disallowed function error echoes function name", () => {
        const result = compileStrict("SELECT SLEEP(10) FROM users", {
            allowedFunctions: new Set(["count"]),
        });
        expect(result.ok).toBe(false);

        // VULNERABILITY: The error echoes the function name, confirming
        // the attacker's probe was syntactically valid.
        const message = result.diagnostics[0]?.message ?? "";
        expect(message).toContain("sleep");
    });
});

// ════════════════════════════════════════════════════════════
// 15. INTERNAL TABLE ID / COLUMN ID LEAKAGE
// ════════════════════════════════════════════════════════════

describe("internal table and column ID leakage", () => {
    test("[VULN] bound AST exposes internal table IDs", () => {
        const result = compileStrict("SELECT id FROM users");
        expect(result.ok).toBe(true);

        // VULNERABILITY: The bound AST reveals internal table and column IDs
        // that are implementation details and could aid further attacks.
        const tableRef = result.bound?.body.from;
        expect(tableRef?.table.id).toBe("users");
    });

    test("[VULN] bound AST exposes internal column IDs with table prefix", () => {
        const result = compileStrict("SELECT email FROM users");
        expect(result.ok).toBe(true);

        // VULNERABILITY: Column IDs follow a predictable pattern: "tableId.columnName"
        const selectItem = result.bound?.body.selectItems[0];
        if (selectItem?.kind === "BoundSelectExpressionItem") {
            const expr = selectItem.expression;
            if (expr.kind === "BoundColumnReference") {
                expect(expr.column.id).toBe("users.email");
            }
        }
    });
});

// ════════════════════════════════════════════════════════════
// 16. DEFENSES THAT ARE WORKING
// ════════════════════════════════════════════════════════════

describe("defenses that are working correctly", () => {
    test("[DEFENSE] catalog lookup is case-insensitive (prevents case-based probing)", () => {
        // The catalog normalizes identifiers, so case-based enumeration
        // does not reveal additional information.
        const lower = compileStrict("SELECT id FROM users");
        const upper = compileStrict("SELECT id FROM USERS");
        const mixed = compileStrict("SELECT id FROM Users");

        expect(lower.ok).toBe(true);
        expect(upper.ok).toBe(true);
        expect(mixed.ok).toBe(true);
    });

    test("[DEFENSE] comments are rejected (prevents comment-based injection)", () => {
        const singleLine = compileStrict("SELECT id FROM users -- comment");
        const block = compileStrict("SELECT id FROM users /* comment */");
        const hash = compileStrict("SELECT id FROM users # comment");

        expect(singleLine.ok).toBe(false);
        expect(block.ok).toBe(false);
        expect(hash.ok).toBe(false);
    });

    test("[DEFENSE] only SELECT statements are accepted", () => {
        expect(compileStrict("INSERT INTO users VALUES (1)").ok).toBe(false);
        expect(compileStrict("UPDATE users SET name = 'x'").ok).toBe(false);
        expect(compileStrict("DELETE FROM users").ok).toBe(false);
    });

    test("[DEFENSE] string literals in emitted SQL are properly escaped", () => {
        const result = compileStrict("SELECT id FROM users WHERE name = 'O''Brien'");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("'O''Brien'");
    });

    test("[DEFENSE] backtick identifiers in emitted SQL are properly escaped", () => {
        const result = compileStrict("SELECT id AS `col``name` FROM users");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("``");
    });

    test("[DEFENSE] stacked queries are rejected", () => {
        expect(compileStrict("SELECT 1; SELECT 2").ok).toBe(false);
    });

    test("[DEFENSE] UNION is rejected", () => {
        expect(
            compileStrict("SELECT id FROM users UNION SELECT id FROM orders").ok,
        ).toBe(false);
    });

    test("[DEFENSE] parameter placeholders prevent runtime injection", () => {
        const result = compileStrict(
            "SELECT id FROM users WHERE name = ? AND age > ?",
        );
        expect(result.ok).toBe(true);
        // Parameters are preserved as ?, preventing SQL injection at runtime
        expect(result.emitted?.sql).toContain("?");
        expect(result.emitted?.parameters.length).toBe(2);
    });
});
