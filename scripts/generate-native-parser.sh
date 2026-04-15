#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${VOIGHT_PARSER_TOOLS_DIR:-$ROOT_DIR/tools}"
TOOLCHAIN_MANIFEST="${VOIGHT_ANTLR_MANIFEST:-$TOOLS_DIR/antlr-toolchain.env}"
JAVA_BIN="${JAVA_BIN:-java}"
OUTPUT_DIR="$ROOT_DIR/native/parser/generated"
GRAMMAR_DIR="$ROOT_DIR/native/parser/grammar"
STAMP_FILE="$OUTPUT_DIR/.inputs.sha256"

mkdir -p "$TOOLS_DIR" "$OUTPUT_DIR"

if [[ ! -f "$TOOLCHAIN_MANIFEST" ]]; then
  echo "ANTLR toolchain manifest is missing: $TOOLCHAIN_MANIFEST" >&2
  exit 1
fi

source "$TOOLCHAIN_MANIFEST"

ANTLR_JAR="$TOOLS_DIR/$ANTLR_JAR_NAME"

verify_checksum() {
  local file="$1"
  local expected="$2"
  local actual

  actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "Checksum mismatch for $file" >&2
    echo "Expected: $expected" >&2
    echo "Actual:   $actual" >&2
    return 1
  fi
}

if [[ ! -f "$ANTLR_JAR" ]]; then
  temp_jar="$(mktemp "$TOOLS_DIR/antlr-download.XXXXXX.jar")"
  trap 'rm -f "$temp_jar"' EXIT
  curl --fail --location --proto '=https' --tlsv1.2 "$ANTLR_URL" -o "$temp_jar"
  verify_checksum "$temp_jar" "$ANTLR_SHA256"
  mv "$temp_jar" "$ANTLR_JAR"
  trap - EXIT
else
  verify_checksum "$ANTLR_JAR" "$ANTLR_SHA256"
fi

input_fingerprint="$(
  shasum -a 256 \
    "$TOOLCHAIN_MANIFEST" \
    "$GRAMMAR_DIR/VoightLexer.g4" \
    "$GRAMMAR_DIR/VoightParser.g4" \
    | shasum -a 256 | awk '{print $1}'
)"

if [[ -f "$STAMP_FILE" ]] && [[ "$(cat "$STAMP_FILE")" == "$input_fingerprint" ]]; then
  exit 0
fi

temp_output="$(mktemp -d "$ROOT_DIR/native/parser/generated.tmp.XXXXXX")"
trap 'rm -rf "$temp_output"' EXIT

pushd "$GRAMMAR_DIR" >/dev/null
"$JAVA_BIN" -jar "$ANTLR_JAR" -Dlanguage=Cpp -no-listener -o "$temp_output" VoightLexer.g4
"$JAVA_BIN" -jar "$ANTLR_JAR" -Dlanguage=Cpp -visitor -no-listener -lib "$temp_output" -o "$temp_output" VoightParser.g4
popd >/dev/null

printf '%s\n' "$input_fingerprint" > "$temp_output/.inputs.sha256"
rm -rf "$OUTPUT_DIR"
mv "$temp_output" "$OUTPUT_DIR"
trap - EXIT
