#include <string>

#include <emscripten/bind.h>
#include <emscripten/emscripten.h>

#include "parser_json.h"

namespace {

std::string parse_query_wasm(const std::string& input) {
  return parse_query_json(input);
}

}  // namespace

EMSCRIPTEN_BINDINGS(voight_parser) {
  emscripten::function("parseQuery", &parse_query_wasm);
}
