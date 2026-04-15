#include <iostream>
#include <sstream>
#include <string>

#include "parser_json.h"

int main() {
  std::ostringstream input;
  input << std::cin.rdbuf();
  std::cout << parse_query_json(input.str());
  return 0;
}
