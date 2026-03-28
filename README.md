# voight

`voight` is a small SQL compiler for a restricted MySQL-style `SELECT` dialect.

## Stages

`voight` runs SQL through these stages:

1. `lex` parses raw text into tokens
2. `parse` builds an AST
3. `rewrite` applies query rewrites
4. `bind` resolves tables and columns against a catalog
5. `analyze` extracts semantic facts
6. `enforce` applies compiler rules and policies
7. `emit` produces canonical SQL

The result is a normalized query plus structured diagnostics when something fails.

## What It Does

- Accepts a controlled subset of `SELECT`
- Resolves tables and columns from a catalog
- Normalizes emitted SQL
- Supports CTEs, joins, subqueries, grouping, ordering, and limits
- Supports virtual table aliases through the catalog
- Provides stage-by-stage compiler results for debugging

## Example

```ts
import { compile, createTestCatalog } from "voight";

const result = compile(
    "SELECT id, name FROM users WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 10",
    {
        catalog: createTestCatalog(),
        dialect: "mysql",
        strict: true,
    },
);

if (result.ok) {
    console.log(result.emitted.sql);
    // SELECT `users`.`id`, `users`.`name` FROM `users`
    // WHERE `users`.`tenant_id` = ? ORDER BY `users`.`created_at` DESC LIMIT 10
}
```

## Virtual Table Aliases

Logical table names can be mapped to physical tables by wrapping the catalog.

```ts
import { AliasCatalog, compile, createCatalogAlias, createTestCatalog } from "voight";

const catalog = new AliasCatalog(createTestCatalog(), [
    createCatalogAlias({
        from: ["projects"],
        to: ["internal_projects"],
    }),
]);

const result = compile("SELECT id, name FROM projects WHERE tenant_id = ?", {
    catalog,
    dialect: "mysql",
    strict: true,
});
```

This emits SQL against `internal_projects`, while the user can keep writing `projects`.

## Diagnostics

Failures are reported at the stage where they happen.

```ts
const result = compile("SELECT id FROM missing", {
    catalog: createTestCatalog(),
    dialect: "mysql",
    strict: true,
});

console.log(result.ok); // false
console.log(result.terminalStage); // "binder"
console.log(result.diagnostics[0]?.message); // Unknown table "missing".
```

## Development

```bash
npm install
npm test
```
