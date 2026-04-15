#include "error.h"

ParserError::ParserError(const std::string& message, size_t start, size_t end)
    : std::runtime_error(message), start(start), end(end) {}

ParserError::ParserError(const char* message, size_t start, size_t end)
    : std::runtime_error(message), start(start), end(end) {}

SyntaxError::SyntaxError(const std::string& message, size_t start, size_t end)
    : ParserError(message, start, end) {}

SyntaxError::SyntaxError(const char* message, size_t start, size_t end)
    : ParserError(message, start, end) {}

UnsupportedConstructError::UnsupportedConstructError(
    const std::string& message,
    size_t start,
    size_t end
)
    : ParserError(message, start, end) {}

UnsupportedConstructError::UnsupportedConstructError(const char* message, size_t start, size_t end)
    : ParserError(message, start, end) {}

InvalidIdentifierError::InvalidIdentifierError(const std::string& message, size_t start, size_t end)
    : ParserError(message, start, end) {}

InvalidIdentifierError::InvalidIdentifierError(const char* message, size_t start, size_t end)
    : ParserError(message, start, end) {}

ParsingError::ParsingError(const std::string& message, size_t start, size_t end)
    : ParserError(message, start, end) {}

ParsingError::ParsingError(const char* message, size_t start, size_t end)
    : ParserError(message, start, end) {}
