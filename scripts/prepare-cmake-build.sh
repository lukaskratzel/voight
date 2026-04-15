#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <build-dir> <source-dir>" >&2
  exit 1
fi

BUILD_DIR="$1"
SOURCE_DIR="$2"
CACHE_FILE="$BUILD_DIR/CMakeCache.txt"

if [[ ! -f "$CACHE_FILE" ]]; then
  exit 0
fi

SOURCE_VALUE="$(sed -n 's/^CMAKE_HOME_DIRECTORY:INTERNAL=//p' "$CACHE_FILE" | head -n 1)"

if [[ -n "$SOURCE_VALUE" && "$SOURCE_VALUE" != "$SOURCE_DIR" ]]; then
  rm -rf "$BUILD_DIR"
fi
