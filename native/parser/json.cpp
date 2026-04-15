#include "json.h"

#include <charconv>
#include <iomanip>
#include <limits>
#include <system_error>
#include <stdexcept>

static const Json::String empty_string;
static const Json::Array empty_array;
static const Json::Object empty_object;

Json::Json(std::initializer_list<Json> init) : value(Array(init)) {}

Json& Json::operator[](const std::string& key) {
  if (isNull()) {
    value = Object{};
  }
  if (!isObject()) {
    throw std::runtime_error("Json::operator[](string): not an object");
  }
  auto& object = std::get<Object>(value);
  for (auto& [current_key, current_value] : object) {
    if (current_key == key) {
      return current_value;
    }
  }
  object.emplace_back(key, Json{});
  return object.back().second;
}

Json& Json::operator[](size_t index) {
  if (isNull()) {
    value = Array{};
  }
  if (!isArray()) {
    throw std::runtime_error("Json::operator[](size_t): not an array");
  }
  auto& array = std::get<Array>(value);
  if (index >= array.size()) {
    array.resize(index + 1);
  }
  return array[index];
}

const Json::String& Json::getString() const {
  return isString() ? std::get<String>(value) : empty_string;
}

Json::Int Json::getInt(Int defaultVal) const {
  if (isInt()) {
    return std::get<Int>(value);
  }
  if (isFloat()) {
    return static_cast<Int>(std::get<Float>(value));
  }
  return defaultVal;
}

const Json::Array& Json::getArray() const {
  return isArray() ? std::get<Array>(value) : empty_array;
}

const Json::Object& Json::getObject() const {
  return isObject() ? std::get<Object>(value) : empty_object;
}

Json::Array& Json::getArrayMut() {
  if (isNull()) {
    value = Array{};
  }
  if (!isArray()) {
    throw std::runtime_error("Json::getArrayMut(): not an array");
  }
  return std::get<Array>(value);
}

Json::Object& Json::getObjectMut() {
  if (isNull()) {
    value = Object{};
  }
  if (!isObject()) {
    throw std::runtime_error("Json::getObjectMut(): not an object");
  }
  return std::get<Object>(value);
}

const Json* Json::find(const std::string& key) const {
  if (!isObject()) {
    return nullptr;
  }

  const auto& object = std::get<Object>(value);
  for (const auto& [current_key, current_value] : object) {
    if (current_key == key) {
      return &current_value;
    }
  }

  return nullptr;
}

void Json::pushBack(const Json& val) {
  getArrayMut().push_back(val);
}

void Json::pushBack(Json&& val) {
  getArrayMut().push_back(std::move(val));
}

void Json::reserveArray(size_t capacity) {
  getArrayMut().reserve(capacity);
}

void Json::reserveObject(size_t capacity) {
  getObjectMut().reserve(capacity);
}

size_t Json::size() const {
  if (isArray()) {
    return std::get<Array>(value).size();
  }
  if (isObject()) {
    return std::get<Object>(value).size();
  }
  if (isString()) {
    return std::get<String>(value).size();
  }
  return 0;
}

bool Json::empty() const {
  if (isArray()) {
    return std::get<Array>(value).empty();
  }
  if (isObject()) {
    return std::get<Object>(value).empty();
  }
  if (isString()) {
    return std::get<String>(value).empty();
  }
  return isNull();
}

std::string Json::escapeString(const std::string& s) {
  std::string escaped;
  escaped.reserve(s.size() + 2);
  appendEscapedString(escaped, s);
  return escaped;
}

std::string Json::dump() const {
  std::string output;
  output.reserve(64);
  dumpTo(output);
  return output;
}

void Json::appendTrustedObjectKey(std::string& out, const std::string& key) {
  out.push_back('"');
  out += key;
  out += "\":";
}

void Json::dumpTo(std::string& out) const {
  std::visit(
      [&out](const auto& current) {
        using T = std::decay_t<decltype(current)>;

        if constexpr (std::is_same_v<T, Null>) {
          out += "null";
        } else if constexpr (std::is_same_v<T, Bool>) {
          out += current ? "true" : "false";
        } else if constexpr (std::is_same_v<T, Int>) {
          char buffer[32];
          auto [ptr, ec] = std::to_chars(std::begin(buffer), std::end(buffer), current);
          if (ec != std::errc()) {
            throw std::runtime_error("Json::dumpTo(int): failed to encode integer");
          }
          out.append(buffer, ptr);
        } else if constexpr (std::is_same_v<T, Float>) {
          char buffer[64];
          auto [ptr, ec] =
              std::to_chars(std::begin(buffer), std::end(buffer), current, std::chars_format::general);
          if (ec != std::errc()) {
            throw std::runtime_error("Json::dumpTo(float): failed to encode float");
          }
          out.append(buffer, ptr);
        } else if constexpr (std::is_same_v<T, String>) {
          Json::appendEscapedString(out, current);
        } else if constexpr (std::is_same_v<T, Raw>) {
          out += current.json;
        } else if constexpr (std::is_same_v<T, Array>) {
          if (current.empty()) {
            out += "[]";
            return;
          }

          out.push_back('[');
          for (size_t i = 0; i < current.size(); ++i) {
            if (i > 0) {
              out.push_back(',');
            }
            current[i].dumpTo(out);
          }
          out.push_back(']');
        } else if constexpr (std::is_same_v<T, Object>) {
          if (current.empty()) {
            out += "{}";
            return;
          }

          out.push_back('{');
          bool first = true;
          for (const auto& [key, value] : current) {
            if (!first) {
              out.push_back(',');
            }
            first = false;
            Json::appendTrustedObjectKey(out, key);
            value.dumpTo(out);
          }
          out.push_back('}');
        }
      },
      value);
}

void Json::appendEscapedString(std::string& out, const std::string& s) {
  constexpr char hex_digits[] = "0123456789abcdef";

  out.push_back('"');
  for (unsigned char c : s) {
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (c < 0x20) {
          out += "\\u00";
          out.push_back(hex_digits[(c >> 4) & 0x0f]);
          out.push_back(hex_digits[c & 0x0f]);
        } else {
          out.push_back(static_cast<char>(c));
        }
        break;
    }
  }
  out.push_back('"');
}
