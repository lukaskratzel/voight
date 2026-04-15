#pragma once

#include <cstdint>
#include <initializer_list>
#include <string>
#include <utility>
#include <variant>
#include <vector>

struct RawJson {
  std::string json;
  explicit RawJson(std::string s) : json(std::move(s)) {}
};

class Json {
 public:
  using Null = std::nullptr_t;
  using Bool = bool;
  using Int = int64_t;
  using Float = double;
  using String = std::string;
  using Raw = RawJson;
  using Array = std::vector<Json>;
  using ObjectEntry = std::pair<std::string, Json>;
  using Object = std::vector<ObjectEntry>;
  using Value = std::variant<Null, Bool, Int, Float, String, Raw, Array, Object>;

  Json() : value(nullptr) {}
  Json(std::nullptr_t) : value(nullptr) {}
  Json(bool b) : value(b) {}
  Json(int i) : value(static_cast<Int>(i)) {}
  Json(int64_t i) : value(i) {}
  Json(size_t i) : value(static_cast<Int>(i)) {}
  Json(double d) : value(d) {}
  Json(float f) : value(static_cast<Float>(f)) {}
  Json(const char* s) : value(String(s)) {}
  Json(const std::string& s) : value(s) {}
  Json(std::string&& s) : value(std::move(s)) {}
  Json(const Array& arr) : value(arr) {}
  Json(Array&& arr) : value(std::move(arr)) {}
  Json(std::initializer_list<Json> init);
  Json(const Object& obj) : value(obj) {}
  Json(Object&& obj) : value(std::move(obj)) {}
  Json(const RawJson& raw) : value(raw) {}
  Json(RawJson&& raw) : value(std::move(raw)) {}

  Json(const Json&) = default;
  Json(Json&&) = default;
  Json& operator=(const Json&) = default;
  Json& operator=(Json&&) = default;

  Json& operator[](const std::string& key);
  Json& operator[](const char* key) { return (*this)[std::string(key)]; }
  Json& operator[](size_t index);

  bool isNull() const { return std::holds_alternative<Null>(value); }
  bool isBool() const { return std::holds_alternative<Bool>(value); }
  bool isInt() const { return std::holds_alternative<Int>(value); }
  bool isFloat() const { return std::holds_alternative<Float>(value); }
  bool isNumber() const { return isInt() || isFloat(); }
  bool isString() const { return std::holds_alternative<String>(value); }
  bool isArray() const { return std::holds_alternative<Array>(value); }
  bool isObject() const { return std::holds_alternative<Object>(value); }
  bool isRaw() const { return std::holds_alternative<Raw>(value); }

  Int getInt(Int defaultVal = 0) const;
  const String& getString() const;
  const Array& getArray() const;
  const Object& getObject() const;
  Array& getArrayMut();
  Object& getObjectMut();
  const Json* find(const std::string& key) const;

  void pushBack(const Json& val);
  void pushBack(Json&& val);
  void reserveArray(size_t capacity);
  void reserveObject(size_t capacity);
  size_t size() const;
  bool empty() const;

  std::string dump() const;

  static Json object() { return Json(Object{}); }
  static Json array() { return Json(Array{}); }
  static Json raw(const std::string& jsonStr) { return Json(RawJson(jsonStr)); }
  static std::string escapeString(const std::string& s);

 private:
  Value value;

  void dumpTo(std::string& out) const;
  static void appendTrustedObjectKey(std::string& out, const std::string& key);
  static void appendEscapedString(std::string& out, const std::string& s);
};
