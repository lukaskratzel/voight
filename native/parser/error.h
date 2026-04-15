#pragma once

#include <stdexcept>
#include <string>

class ParserError : public std::runtime_error {
 public:
  size_t start;
  size_t end;

  explicit ParserError(const std::string& message, size_t start, size_t end);
  explicit ParserError(const char* message, size_t start, size_t end);
};

class SyntaxError : public ParserError {
 public:
  explicit SyntaxError(const std::string& message, size_t start, size_t end);
  explicit SyntaxError(const char* message, size_t start, size_t end);
};

class UnsupportedConstructError : public ParserError {
 public:
  explicit UnsupportedConstructError(const std::string& message, size_t start, size_t end);
  explicit UnsupportedConstructError(const char* message, size_t start, size_t end);
};

class InvalidIdentifierError : public ParserError {
 public:
  explicit InvalidIdentifierError(const std::string& message, size_t start, size_t end);
  explicit InvalidIdentifierError(const char* message, size_t start, size_t end);
};

class ParsingError : public ParserError {
 public:
  explicit ParsingError(const std::string& message, size_t start, size_t end);
  explicit ParsingError(const char* message, size_t start, size_t end);
};
