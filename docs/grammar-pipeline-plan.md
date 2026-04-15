# Grammar-Driven Parser Plan

## Goal

Refactor `voight` so the lexer/parser are generated from a grammar, while preserving the current compiler architecture:

1. parse restricted analytics SQL (`SELECT` only)
2. keep policy rewrites and enforcement as first-class library features
3. expose a TypeScript-friendly API
4. support a WebAssembly parser target

The intended shape is close to PostHog's HogQL pipeline:

- grammar as the source of truth
- generated parser runtime
- handwritten parse-tree-to-domain-AST conversion
- stable AST contract consumed by the rest of the compiler

## What PostHog Is Doing That Matters

Relevant local references:

- [`posthog/posthog/hogql/grammar/README.md`](/Users/lukaskratzel/Dev/alchemist/posthog/posthog/hogql/grammar/README.md)
- [`posthog/posthog/hogql/grammar/HogQLLexer.common.g4`](/Users/lukaskratzel/Dev/alchemist/posthog/posthog/hogql/grammar/HogQLLexer.common.g4)
- [`posthog/common/hogql_parser/CMakeLists.txt`](/Users/lukaskratzel/Dev/alchemist/posthog/common/hogql_parser/CMakeLists.txt)
- [`posthog/common/hogql_parser/parser_wasm.cpp`](/Users/lukaskratzel/Dev/alchemist/posthog/common/hogql_parser/parser_wasm.cpp)
- [`posthog/common/hogql_parser/parser_json.cpp`](/Users/lukaskratzel/Dev/alchemist/posthog/common/hogql_parser/parser_json.cpp)

Patterns worth copying:

1. The grammar owns syntax, not the handwritten parser.
2. Generated lexer/parser code is treated as build output, not hand-maintained logic.
3. The product does not bind the rest of the system directly to ANTLR parse trees.
4. A handwritten conversion layer maps parse trees into a stable AST/JSON representation.
5. The same parser core is reused for multiple targets, including WebAssembly.
6. Unsupported grammar features are rejected explicitly in the conversion layer.

That fourth point is the key one for `voight`: your policy engine should depend on `QueryAst`, not on ANTLR, parse contexts, token types, or generated classes.

## What To Keep In Voight

Keep these layers conceptually unchanged:

- `rewrite`
- `bind`
- `enforce`
- `emit`
- policy interfaces in [`src/policies.ts`](/Users/lukaskratzel/Dev/alchemist/src/policies.ts)
- canonical domain AST in [`src/ast.ts`](/Users/lukaskratzel/Dev/alchemist/src/ast.ts)

The handwritten lexer and parser in:

- [`src/lexer.ts`](/Users/lukaskratzel/Dev/alchemist/src/lexer.ts)
- [`src/parser.ts`](/Users/lukaskratzel/Dev/alchemist/src/parser.ts)

should be replaced by:

- a grammar package
- a generated parser target
- a parse-tree adapter that produces `QueryAst`

## Recommended Architecture

### 1. Split "syntax AST" from "semantic AST" only if needed

Right now your `QueryAst` is already close to the semantic shape your rewriter, binder, and policies need. That is good. Do not replace it with generated parse-tree types.

Preferred approach:

- keep `QueryAst` as the compiler-facing AST
- generate a parser that produces a parse tree
- convert the parse tree into `QueryAst`

Only introduce an intermediate "raw syntax AST" if the grammar starts encoding more syntax than the policy/binder pipeline wants to see.

### 2. Introduce a parser backend boundary

Add a narrow interface such as:

```ts
export interface ParserBackend {
    parseQuery(source: string): ParseBackendResult;
}

export interface ParseBackendResult {
    readonly ok: boolean;
    readonly ast?: QueryAst;
    readonly diagnostics: readonly Diagnostic[];
}
```

This lets you support:

- `generated-wasm` backend for production
- optional `generated-native` or `generated-js` backend for development/tests
- temporary `legacy-handwritten` backend during migration

### 3. Keep diagnostics owned by Voight

PostHog returns parser-native JSON errors from WASM and wraps them at the boundary. You want the same idea, but the final diagnostic type should remain your own:

- `CompilerStage.Lexer`
- `CompilerStage.Parser`
- `DiagnosticCode.*`

So the adapter should translate generator/runtime errors into `voight` diagnostics. Do not leak raw ANTLR error strings through your public API without normalization.

### 4. Treat unsupported SQL as semantic gating, not grammar scope creep

You want an analytics-oriented language, but only `SELECT`. The clean strategy is:

- grammar accepts the syntax you plausibly want to support long-term
- adapter rejects constructs you are not ready to model
- binder/enforcer reject constructs that are syntactically valid but not allowed by policy/runtime

This is how PostHog avoids overloading the grammar with every product restriction.

## Practical Voight Pipeline

Recommended future compile flow:

1. `parse(source)` via generated parser backend
2. `adapter(parseTree/json) -> QueryAst`
3. `rewrite(QueryAst, policies, rewriters)`
4. `bind(QueryAst, catalog)`
5. `enforce(BoundQuery, policies)`
6. `emit(BoundQuery)`

In other words, the generated parser replaces only the front-end, not the compiler core.

## Why WASM Is A Good Fit Here

For a TypeScript library, the PostHog shape is a good fit:

- grammar and conversion logic can live in a strongly typed compiled target
- npm package exposes a small async factory and a few parse functions
- TS stays focused on compiler semantics, policy composition, and integration

That said, there is one important design choice.

### Recommendation: return a Voight-shaped JSON AST from WASM

Do not return raw parse trees to TypeScript.

Prefer this:

- WASM parse function returns JSON for a `voight` syntax tree shape
- TS parses the JSON and validates/minimally hydrates it into `QueryAst`

Avoid this:

- WASM returns token stream or parse tree
- TS performs the real tree conversion

Reason:

- it duplicates grammar knowledge across languages
- it weakens the parser boundary
- it makes generator upgrades harder

This is the closest useful analogue to PostHog's `parser_json.cpp`.

## Grammar Scope For Voight V1

Keep the first grammar deliberately smaller than HogQL. Suggested scope:

- `WITH`
- `SELECT`
- projection expressions and aliases
- `FROM`
- derived tables
- `INNER JOIN` and `LEFT JOIN`
- `WHERE`
- `GROUP BY`
- `HAVING`
- `ORDER BY`
- `LIMIT` and optional `OFFSET`
- parameters (`?`)
- scalar subqueries
- `EXISTS`
- `IN (...)`
- `IN (subquery)`
- function calls
- identifiers, qualified references, literals
- boolean and arithmetic operators

Explicitly exclude in V1:

- `UNION`
- DML and DDL
- window functions
- lateral joins
- vendor-specific hints/settings
- comments if you still want a strict safe-sql surface

That maps closely to your existing AST and avoids a destabilizing binder rewrite.

## Suggested Repository Layout

```text
src/
  ast.ts
  binder.ts
  compiler.ts
  diagnostics.ts
  emitter.ts
  enforcer.ts
  policies.ts
  rewriter.ts
  parser/
    backend.ts
    adapter.ts
    wasm.ts
    validation.ts

grammar/
  VoightLexer.g4
  VoightParser.g4
  README.md

native/
  parser/
    CMakeLists.txt
    parser_wasm.cpp
    parser_json.cpp
    error.h
    error.cpp
    json.h
    json.cpp

scripts/
  build-grammar.sh
  build-parser-wasm.sh
```

## Migration Strategy

### Phase 1. Freeze the compiler-facing AST

Before changing parsing technology:

- confirm `src/ast.ts` is the long-lived policy/binder contract
- document any AST shape changes you are willing to make now
- avoid changing policy APIs during parser migration

### Phase 2. Write the grammar against current behavior

Start with a grammar that matches the current supported subset, not the ideal future language.

That minimizes simultaneous change in:

- accepted syntax
- AST shape
- diagnostics
- binder expectations

### Phase 3. Build a handwritten adapter

This is the most important new layer.

Responsibilities:

- map grammar output into `QueryAst`
- normalize aliases and operator forms
- reject parse-tree branches you are intentionally not supporting
- convert parser errors into `Diagnostic`

### Phase 4. Run old and new parsers in parallel

During migration, add a test helper that:

- parses with handwritten parser
- parses with generated parser
- compares AST snapshots or emitted SQL

For a compiler library, comparing emitted SQL plus selected AST snapshots is usually more stable than full raw AST equality.

### Phase 5. Flip the default backend

Once parity is high enough:

- default to generated backend
- keep legacy parser behind a flag briefly
- delete handwritten lexer/parser after a short overlap window

## How Policies Fit Cleanly

Your policy system should stay entirely downstream from parsing:

- parsing answers "what did the user write?"
- rewrite policies answer "how do we transform it safely?"
- enforcement policies answer "is the bound query allowed?"

That means:

- parser should not know tenant scoping rules
- parser should not know allowed-functions policy
- parser should not know catalog semantics

This separation is already one of the stronger parts of `voight`, and the migration should reinforce it.

## Specific PostHog Patterns To Reuse

### Reuse directly

- grammar as checked-in source
- generated code for lexer/parser
- WASM package build around CMake + Emscripten
- JSON-returning parser entrypoints
- explicit unsupported-feature errors in adapter/converter layer

### Adapt, not copy

- PostHog's grammar is much broader than your select-only library needs
- their JSON AST is product-specific and loosely typed
- your public TS API needs stronger invariants because the policy engine is a reusable library surface

So the right analogue is:

- "HogQL parser core" -> `voight` parser core
- "parse tree to JSON AST converter" -> `voight` parse tree to `QueryAst` JSON converter
- "frontend parser package" -> your internal or published WASM parser package

## Recommended Technology Choice

If you want to be close to PostHog, use:

- ANTLR4 grammar
- C++ target
- Emscripten for WASM

Why this is defensible:

- proven by the reference implementation you are studying
- strong grammar tooling
- one parser core for multiple targets
- predictable WASM distribution story

Why you might choose differently:

- C++/Emscripten raises maintenance cost
- local contributor setup becomes heavier
- debugging generated parser code is slower than pure TypeScript

If you want a lower-maintenance alternative, the main credible deviation would be:

- grammar-driven parser in TypeScript
- optional WASM later only if profiling proves it necessary

But if your goal is specifically "similar to HogQL with a WASM compilation target", ANTLR -> C++ -> WASM is coherent.

## Main Risks

1. Letting generated parse trees leak into policies or binder.
2. Expanding grammar scope faster than the binder/enforcer can safely support.
3. Reproducing diagnostics and source spans inconsistently across WASM and TS.
4. Returning a parser-native AST that is too unstable for a library API.
5. Shipping a WASM parser before test parity with the handwritten compiler pipeline.

## Concrete Next Steps

1. Create `grammar/VoightLexer.g4` and `grammar/VoightParser.g4` for the current supported subset.
2. Add a `src/parser/backend.ts` abstraction so the compiler no longer depends directly on `src/parser.ts`.
3. Add a native parser package modeled after `posthog/common/hogql_parser`.
4. Implement a `parse-tree -> QueryAst` converter before touching binder or policies.
5. Add parity tests that compare old and new parser outputs on your existing test corpus.
6. Move the TS compiler to consume only the new backend interface.

## Decision Summary

The practical application of the HogQL pattern to `voight` is not "replace your AST and policy engine with a generated parser stack." It is:

- replace handwritten syntax recognition with a grammar-owned parser
- keep `QueryAst` as the stable compiler contract
- insert a strong adapter layer between generated syntax and compiler semantics
- compile the parser core to WASM for the TS library
- keep policy rewrites and enforcement exactly where they already belong
