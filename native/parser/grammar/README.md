# Voight Grammar

This directory contains the grammar source for the next parser frontend.

Current goals:

- target the existing MySQL-oriented `SELECT` subset first
- keep the grammar focused on syntax only
- emit a JSON shape that already matches `QueryAst`
- compile the parser to C++ and then WebAssembly for the TypeScript library

## Scope

The current grammar intentionally models only the subset already supported by `voight`:

- `WITH`
- `SELECT`
- derived tables
- `INNER JOIN` and `LEFT JOIN`
- `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`
- scalar subqueries, `EXISTS`, `IN (...)`, `IN (subquery)`
- arithmetic and boolean expressions
- MySQL-style quoted identifiers using backticks
- positional parameters using `?`

Unsupported SQL should be rejected by the generated parser or by the native JSON conversion layer before the AST reaches TypeScript.

## Generation

Example generation commands with ANTLR 4.13.x:

```bash
./scripts/generate-native-parser.sh
```

The generated sources are expected to live under `native/parser/generated/`.
The grammar itself now lives alongside the native parser package under `native/parser/grammar/`.
ANTLR itself is pinned through `tools/antlr-toolchain.env`, and generation verifies the jar checksum before use.

## Boundary

The native parser should not expose ANTLR parse trees to the TypeScript compiler pipeline.
Instead, it should emit JSON that mirrors `QueryAst` directly, with TypeScript only responsible for:

- parsing the JSON payload
- mapping native parser errors into `Diagnostic`
