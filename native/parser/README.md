# Native Parser Build

This directory contains the C++/WASM parser build pipeline for `voight`.

It is intentionally modeled after PostHog's `common/hogql_parser` split, but the consumable JS package now lives under [`packages/voight-parser/`](/Users/lukaskratzel/Dev/alchemist/packages/voight-parser):

- grammar source lives in [`native/parser/grammar/`](/Users/lukaskratzel/Dev/alchemist/native/parser/grammar)
- ANTLR generates C++ parser artifacts into `native/parser/generated/`
- a handwritten native conversion layer emits JSON mirroring `QueryAst`
- the generated WebAssembly bundle is installed into `packages/voight-parser/dist/`

## Build Flow

The parser is built locally with:

- Java for ANTLR generation
- a pinned ANTLR toolchain manifest in `tools/antlr-toolchain.env`
- Emscripten for the WASM build
- CMake + Ninja for compilation

Build the WASM parser package:

```bash
pnpm parser:build
```

That produces the host-consumable package under `packages/voight-parser/dist/`.

Use the generated WASM package on the host:

```bash
bun -e "import { createVoightParser } from './packages/voight-parser/index.ts'; const parser = await createVoightParser(); console.log(parser.parseQuery('SELECT 1'));"
```

## Expected Output Contract

The parser entrypoints return a JSON string with either:

1. a `QueryAst`-like object using the same `kind` names as `packages/voight/src/ast.ts`
2. an error object like:

```json
{
  "error": true,
  "type": "SyntaxError",
  "message": "Expected ...",
  "span": { "start": 10, "end": 14 }
}
```

Using the same node kinds on both sides keeps the TypeScript hydration layer small and preserves the compiler and policy boundary.
