#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARSER_PACKAGE_DIR="${VOIGHT_PARSER_PACKAGE_DIR:-$ROOT_DIR/packages/voight-parser}"
VOIGHT_PACKAGE_PARSER_DIR="$ROOT_DIR/packages/voight/src/parser"

if ! command -v emcmake >/dev/null 2>&1; then
  echo "Missing Emscripten toolchain. Install emsdk or otherwise make \`emcmake\` available in PATH." >&2
  exit 1
fi

if ! command -v java >/dev/null 2>&1; then
  echo "Missing Java runtime. Install Java or set JAVA_BIN for ANTLR code generation." >&2
  exit 1
fi

if [[ ! -d "$PARSER_PACKAGE_DIR" ]]; then
  echo "Parser package directory does not exist: $PARSER_PACKAGE_DIR" >&2
  exit 1
fi

rm -rf "$PARSER_PACKAGE_DIR/dist"
mkdir -p "$PARSER_PACKAGE_DIR/dist"

export VOIGHT_PARSER_PACKAGE_DIR="$PARSER_PACKAGE_DIR"

cd "$ROOT_DIR/native/parser"
pnpm run build

cp "$PARSER_PACKAGE_DIR/dist/voight_parser_wasm.js" \
  "$VOIGHT_PACKAGE_PARSER_DIR/voight_parser_wasm.js"
