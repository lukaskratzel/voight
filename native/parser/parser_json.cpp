#include <algorithm>
#include "parser_json.h"

#include <optional>
#include <string>

#include "antlr4-runtime.h"

#include "error.h"
#include "generated/VoightLexer.h"
#include "generated/VoightParser.h"
#include "json.h"

using namespace std;

namespace {

class ParserErrorListener : public antlr4::BaseErrorListener {
 public:
  const std::optional<SyntaxError>& error() const { return error_; }

  void syntaxError(
      antlr4::Recognizer*,
      antlr4::Token* offending_symbol,
      size_t,
      size_t,
      const string& message,
      exception_ptr
  ) override {
    if (offending_symbol != nullptr) {
      error_ = SyntaxError(
          message,
          static_cast<size_t>(offending_symbol->getStartIndex()),
          static_cast<size_t>(offending_symbol->getStopIndex() + 1));
      return;
    }

    error_ = SyntaxError(message, 0, 0);
  }

 private:
  std::optional<SyntaxError> error_;
};

class PreparedParse {
 public:
  explicit PreparedParse(const string& input)
      : input_stream_(input), lexer_(&input_stream_), token_stream_(&lexer_), parser_(&token_stream_) {
    token_stream_.fill();

    for (auto* token : token_stream_.getTokens()) {
      if (token->getType() == VoightLexer::UNSUPPORTED_COMMENT) {
        throw UnsupportedConstructError(
            "Comments are not supported.",
            static_cast<size_t>(token->getStartIndex()),
            static_cast<size_t>(token->getStopIndex() + 1));
      }
    }

    parser_.removeErrorListeners();
    parser_.addErrorListener(&error_listener_);
  }

  VoightParser::QueryContext* parse() {
    auto* tree = parser_.query();
    if (error_listener_.error().has_value()) {
      const auto& error = error_listener_.error().value();
      throw SyntaxError(error.what(), error.start, error.end);
    }
    return tree;
  }

 private:
  antlr4::ANTLRInputStream input_stream_;
  VoightLexer lexer_;
  antlr4::CommonTokenStream token_stream_;
  VoightParser parser_;
  ParserErrorListener error_listener_;
};

class NativeAstBuilder {
 public:
  Json build_query(VoightParser::QueryContext* ctx) {
    return build_query_expression(ctx->queryExpression());
  }

 private:
  Json build_query_expression(VoightParser::QueryExpressionContext* ctx) {
    Json json = node("Query", ctx);
    json["body"] = build_select_statement(ctx->selectStatement());
    if (ctx->withClause() != nullptr) {
      json["with"] = build_with_clause(ctx->withClause());
    }
    return json;
  }

  Json build_with_clause(VoightParser::WithClauseContext* ctx) {
    Json json = node("WithClause", ctx);
    Json ctes = Json::array();
    ctes.reserveArray(ctx->commonTableExpression().size());
    for (auto* cte : ctx->commonTableExpression()) {
      ctes.pushBack(build_common_table_expression(cte));
    }
    json["ctes"] = std::move(ctes);
    return json;
  }

  Json build_common_table_expression(VoightParser::CommonTableExpressionContext* ctx) {
    Json json = node("CommonTableExpression", ctx);
    json["name"] = build_identifier(ctx->identifier());
    Json columns = Json::array();
    if (ctx->columnList() != nullptr) {
      columns.reserveArray(ctx->columnList()->identifier().size());
      for (auto* identifier : ctx->columnList()->identifier()) {
        columns.pushBack(build_identifier(identifier));
      }
    }
    json["columns"] = std::move(columns);
    json["query"] = build_query_expression(ctx->queryExpression());
    return json;
  }

  Json build_select_statement(VoightParser::SelectStatementContext* ctx) {
    Json json = node("SelectStatement", ctx);
    json["distinct"] = ctx->DISTINCT() != nullptr;
    Json select_items = Json::array();
    select_items.reserveArray(ctx->selectItem().size());
    for (auto* item : ctx->selectItem()) {
      select_items.pushBack(build_select_item(item));
    }
    json["selectItems"] = std::move(select_items);

    if (ctx->fromClause() != nullptr) {
      json["from"] = build_table_reference(ctx->fromClause()->tableReference());
    }

    Json joins = Json::array();
    joins.reserveArray(ctx->joinClause().size());
    for (auto* join : ctx->joinClause()) {
      joins.pushBack(build_join_clause(join));
    }
    json["joins"] = std::move(joins);

    if (ctx->whereClause() != nullptr) {
      json["whereSpan"] = span_json(ctx->whereClause());
      json["where"] = build_expression(ctx->whereClause()->expression());
    }

    Json group_by = Json::array();
    if (ctx->groupByClause() != nullptr) {
      group_by.reserveArray(ctx->groupByClause()->expression().size());
      for (auto* expression : ctx->groupByClause()->expression()) {
        group_by.pushBack(build_expression(expression));
      }
    }
    json["groupBy"] = std::move(group_by);

    if (ctx->havingClause() != nullptr) {
      json["havingSpan"] = span_json(ctx->havingClause());
      json["having"] = build_expression(ctx->havingClause()->expression());
    }

    Json order_by = Json::array();
    if (ctx->orderByClause() != nullptr) {
      order_by.reserveArray(ctx->orderByClause()->orderByItem().size());
      for (auto* item : ctx->orderByClause()->orderByItem()) {
        order_by.pushBack(build_order_by_item(item));
      }
    }
    json["orderBy"] = std::move(order_by);

    if (ctx->limitClause() != nullptr) {
      json["limit"] = build_limit_clause(ctx->limitClause());
    }

    return json;
  }

  Json build_select_item(VoightParser::SelectItemContext* ctx) {
    if (ctx->ASTERISK() != nullptr && ctx->identifier() == nullptr) {
      return node("SelectWildcardItem", ctx);
    }

    if (ctx->identifier() != nullptr && ctx->ASTERISK() != nullptr) {
      Json json = node("SelectWildcardItem", ctx);
      json["qualifier"] = build_identifier(ctx->identifier());
      return json;
    }

    Json json = node("SelectExpressionItem", ctx);
    json["expression"] = build_expression(ctx->expression());
    if (ctx->alias() != nullptr) {
      json["alias"] = build_identifier(ctx->alias()->identifier());
    }
    return json;
  }

  Json build_table_reference(VoightParser::TableReferenceContext* ctx) {
    if (ctx->queryExpression() != nullptr) {
      Json json = node("DerivedTableReference", ctx);
      json["subquery"] = build_query_expression(ctx->queryExpression());
      json["alias"] = build_identifier(ctx->alias()->identifier());
      return json;
    }

    Json json = node("TableReference", ctx);
    json["name"] = build_qualified_name(ctx->qualifiedName());
    if (ctx->alias() != nullptr) {
      json["alias"] = build_identifier(ctx->alias()->identifier());
    }
    return json;
  }

  Json build_join_clause(VoightParser::JoinClauseContext* ctx) {
    Json json = node("Join", ctx);
    json["table"] = build_table_reference(ctx->tableReference());

    if (ctx->CROSS() != nullptr) {
      json["joinType"] = "INNER";
      json["on"] = boolean_literal(true, ctx->CROSS()->getSymbol());
      return json;
    }

    json["joinType"] = ctx->LEFT() != nullptr ? "LEFT" : "INNER";
    json["on"] = build_expression(ctx->expression());
    return json;
  }

  Json build_order_by_item(VoightParser::OrderByItemContext* ctx) {
    Json json = node("OrderByItem", ctx);
    json["expression"] = build_expression(ctx->expression());
    json["direction"] = ctx->DESC() != nullptr ? "DESC" : "ASC";
    return json;
  }

  Json build_window_specification(VoightParser::WindowSpecificationContext* ctx) {
    Json json = node("WindowSpecification", ctx);

    Json partition_by = Json::array();
    if (ctx->partitionByClause() != nullptr) {
      partition_by.reserveArray(ctx->partitionByClause()->expression().size());
      for (auto* expression : ctx->partitionByClause()->expression()) {
        partition_by.pushBack(build_expression(expression));
      }
    }
    json["partitionBy"] = std::move(partition_by);

    Json order_by = Json::array();
    if (ctx->windowOrderByClause() != nullptr) {
      order_by.reserveArray(ctx->windowOrderByClause()->orderByItem().size());
      for (auto* item : ctx->windowOrderByClause()->orderByItem()) {
        order_by.pushBack(build_order_by_item(item));
      }
    }
    json["orderBy"] = std::move(order_by);

    return json;
  }

  Json build_limit_clause(VoightParser::LimitClauseContext* ctx) {
    Json json = node("LimitClause", ctx);
    auto expressions = ctx->expression();
    if (expressions.empty()) {
      throw ParsingError("LIMIT clause is missing an expression.", span_start(ctx), span_end(ctx));
    }

    if (ctx->COMMA() != nullptr) {
      json["count"] = build_expression(expressions[1]);
      json["offset"] = build_expression(expressions[0]);
    } else {
      json["count"] = build_expression(expressions[0]);
      if (ctx->OFFSET() != nullptr && expressions.size() > 1) {
        json["offset"] = build_expression(expressions[1]);
      }
    }

    return json;
  }

  Json build_expression(VoightParser::ExpressionContext* ctx) {
    return build_or_expression(ctx->orExpression());
  }

  Json build_or_expression(VoightParser::OrExpressionContext* ctx) {
    Json expression = build_and_expression(ctx->andExpression(0));
    for (size_t index = 1; index < ctx->andExpression().size(); ++index) {
      expression = binary_expression("OR", expression, build_and_expression(ctx->andExpression(index)));
    }
    return expression;
  }

  Json build_and_expression(VoightParser::AndExpressionContext* ctx) {
    Json expression = build_comparison_expression(ctx->comparisonExpression(0));
    for (size_t index = 1; index < ctx->comparisonExpression().size(); ++index) {
      expression =
          binary_expression("AND", expression, build_comparison_expression(ctx->comparisonExpression(index)));
    }
    return expression;
  }

  Json build_comparison_expression(VoightParser::ComparisonExpressionContext* ctx) {
    Json expression = build_additive_expression(ctx->additiveExpression(0));

    if (ctx->IS() != nullptr) {
      Json json = node("IsNullExpression", ctx);
      json["operand"] = std::move(expression);
      json["negated"] = ctx->NOT() != nullptr;
      return json;
    }

    if (ctx->IN() != nullptr) {
      return build_in_expression(
          ctx,
          expression,
          ctx->inPredicate(),
          ctx->NOT() != nullptr);
    }

    if (ctx->comparisonOperator() != nullptr) {
      return binary_expression(
          comparison_operator_text(ctx->comparisonOperator()),
          expression,
          build_additive_expression(ctx->additiveExpression(1)));
    }

    return expression;
  }

  Json build_additive_expression(VoightParser::AdditiveExpressionContext* ctx) {
    Json expression = build_multiplicative_expression(ctx->multiplicativeExpression(0));
    size_t plus_index = 0;
    size_t dash_index = 0;

    for (size_t child = 1; child < ctx->children.size(); child += 2) {
      auto* token = dynamic_cast<antlr4::tree::TerminalNode*>(ctx->children[child]);
      const string op =
          token->getSymbol()->getType() == VoightParser::PLUS
              ? ctx->PLUS(plus_index++)->getText()
              : ctx->DASH(dash_index++)->getText();
      expression = binary_expression(
          op, expression, build_multiplicative_expression(ctx->multiplicativeExpression((child + 1) / 2)));
    }

    return expression;
  }

  Json build_multiplicative_expression(VoightParser::MultiplicativeExpressionContext* ctx) {
    Json expression = build_unary_expression(ctx->unaryExpression(0));

    for (size_t child = 1; child < ctx->children.size(); child += 2) {
      auto* token = dynamic_cast<antlr4::tree::TerminalNode*>(ctx->children[child]);
      const string op = token->getText();
      expression = binary_expression(op, expression, build_unary_expression(ctx->unaryExpression((child + 1) / 2)));
    }

    return expression;
  }

  Json build_unary_expression(VoightParser::UnaryExpressionContext* ctx) {
    if (ctx->primaryExpression() != nullptr) {
      return build_primary_expression(ctx->primaryExpression());
    }

    if (ctx->DASH() != nullptr) {
      Json json = node("UnaryExpression", ctx);
      json["operator"] = "-";
      json["operand"] = build_unary_expression(ctx->unaryExpression());
      return json;
    }

    if (ctx->NOT() != nullptr && ctx->EXISTS() != nullptr) {
      Json json = node("ExistsExpression", ctx);
      json["query"] = build_query_expression(ctx->queryExpression());
      json["negated"] = true;
      return json;
    }

    if (ctx->NOT() != nullptr) {
      Json json = node("UnaryExpression", ctx);
      json["operator"] = "NOT";
      json["operand"] = build_unary_expression(ctx->unaryExpression());
      return json;
    }

    if (ctx->EXISTS() != nullptr) {
      Json json = node("ExistsExpression", ctx);
      json["query"] = build_query_expression(ctx->queryExpression());
      json["negated"] = false;
      return json;
    }

    throw ParsingError("Unsupported unary expression.", span_start(ctx), span_end(ctx));
  }

  Json build_primary_expression(VoightParser::PrimaryExpressionContext* ctx) {
    if (ctx->CASE() != nullptr) {
      Json json = node("CaseExpression", ctx);
      const auto when_clauses = ctx->caseWhenClause();

      if (ctx->expression() != nullptr) {
        json["operand"] = build_expression(ctx->expression());
      }

      Json clauses = Json::array();
      clauses.reserveArray(when_clauses.size());
      for (auto* clause : when_clauses) {
        clauses.pushBack(build_case_when_clause(clause));
      }
      json["whenClauses"] = std::move(clauses);

      if (ctx->elseClause() != nullptr) {
        json["elseExpression"] = build_expression(ctx->elseClause()->expression());
      }
      return json;
    }

    if (ctx->CAST() != nullptr) {
      Json json = node("CastExpression", ctx);
      json["expression"] = build_expression(ctx->expression());
      json["targetType"] = build_cast_type(ctx->castType());
      return json;
    }

    if (ctx->INTERVAL() != nullptr) {
      Json json = node("IntervalExpression", ctx);
      json["value"] = build_expression(ctx->expression());
      json["unit"] = interval_unit_name(ctx->intervalUnit());
      return json;
    }

    if (ctx->queryExpression() != nullptr) {
      Json json = node("ScalarSubqueryExpression", ctx);
      json["query"] = build_query_expression(ctx->queryExpression());
      return json;
    }

    if (ctx->expression() != nullptr) {
      Json json = node("GroupingExpression", ctx);
      json["expression"] = build_expression(ctx->expression());
      return json;
    }

    if (ctx->literal() != nullptr) {
      return build_literal(ctx->literal());
    }

    if (ctx->PARAMETER() != nullptr) {
      Json json = node("Parameter", ctx);
      json["index"] = static_cast<int64_t>(ctx->PARAMETER()->getSymbol()->getStartIndex());
      return json;
    }

    if (ctx->CURRENT_TIMESTAMP() != nullptr || ctx->CURRENT_DATE() != nullptr ||
        ctx->CURRENT_TIME() != nullptr) {
      Json json = node("CurrentKeywordExpression", ctx);
      json["keyword"] = ctx->CURRENT_TIMESTAMP() != nullptr
                            ? "CURRENT_TIMESTAMP"
                            : ctx->CURRENT_DATE() != nullptr ? "CURRENT_DATE" : "CURRENT_TIME";
      return json;
    }

    if (ctx->ASTERISK() != nullptr && ctx->identifier().empty()) {
      return node("WildcardExpression", ctx);
    }

    if (ctx->identifier().size() == 1 && ctx->LPAREN() != nullptr) {
      Json json = node("FunctionCall", ctx);
      json["callee"] = build_identifier(ctx->identifier(0));
      json["distinct"] = ctx->DISTINCT() != nullptr;
      json["arguments"] =
          ctx->argumentList() != nullptr ? build_argument_list(ctx->argumentList()) : Json::array();
      if (ctx->windowSpecification() != nullptr) {
        json["over"] = build_window_specification(ctx->windowSpecification());
      }
      return json;
    }

    if (ctx->identifier().size() == 1 && ctx->ASTERISK() != nullptr) {
      Json json = node("WildcardExpression", ctx);
      json["qualifier"] = build_identifier(ctx->identifier(0));
      return json;
    }

    if (ctx->identifier().size() == 2) {
      Json json = node("QualifiedReference", ctx);
      json["qualifier"] = build_identifier(ctx->identifier(0));
      json["column"] = build_identifier(ctx->identifier(1));
      return json;
    }

    if (ctx->identifier().size() == 1) {
      Json json = node("IdentifierExpression", ctx);
      json["identifier"] = build_identifier(ctx->identifier(0));
      return json;
    }

    throw ParsingError("Unsupported primary expression.", span_start(ctx), span_end(ctx));
  }

  Json build_case_when_clause(VoightParser::CaseWhenClauseContext* ctx) {
    Json json = node("CaseWhenClause", ctx);
    json["when"] = build_expression(ctx->expression(0));
    json["then"] = build_expression(ctx->expression(1));
    return json;
  }

  Json build_identifier(VoightParser::IdentifierContext* ctx) {
    Json json = node("Identifier", ctx);
    const string text = ctx->getText();
    const bool quoted = !text.empty() && text.front() == '`';
    const string name = quoted ? decode_quoted_identifier(text) : text;
    if (quoted) {
      validate_quoted_identifier(name, ctx);
    }
    json["name"] = name;
    json["quoted"] = quoted;
    return json;
  }

  Json build_qualified_name(VoightParser::QualifiedNameContext* ctx) {
    Json json = node("QualifiedName", ctx);
    Json parts = Json::array();
    parts.reserveArray(ctx->identifier().size());
    for (auto* identifier : ctx->identifier()) {
      parts.pushBack(build_identifier(identifier));
    }
    json["parts"] = std::move(parts);
    return json;
  }

  Json build_literal(VoightParser::LiteralContext* ctx) {
    Json json = node("Literal", ctx);

    if (ctx->DECIMAL_LITERAL() != nullptr) {
      json["literalType"] = "decimal";
      json["value"] = ctx->DECIMAL_LITERAL()->getText();
      return json;
    }

    if (ctx->INTEGER_LITERAL() != nullptr) {
      json["literalType"] = "integer";
      json["value"] = ctx->INTEGER_LITERAL()->getText();
      return json;
    }

    if (ctx->STRING_LITERAL() != nullptr) {
      json["literalType"] = "string";
      json["value"] = decode_string_literal(ctx->STRING_LITERAL()->getText());
      return json;
    }

    if (ctx->TRUE_SQL() != nullptr || ctx->FALSE_SQL() != nullptr) {
      json["literalType"] = "boolean";
      json["value"] = ctx->TRUE_SQL() != nullptr;
      return json;
    }

    if (ctx->NULL_SQL() != nullptr) {
      json["literalType"] = "null";
      json["value"] = nullptr;
      return json;
    }

    throw ParsingError("Unsupported literal.", span_start(ctx), span_end(ctx));
  }

  Json boolean_literal(bool value, antlr4::Token* token) {
    Json json = Json::object();
    json.reserveObject(4);
    json["kind"] = "Literal";
    json["span"] = span_json(token);
    json["literalType"] = "boolean";
    json["value"] = value;
    return json;
  }

  Json build_cast_type_argument(VoightParser::CastTypeArgumentContext* ctx) {
    if (ctx->INTEGER_LITERAL() != nullptr) {
      Json json = node("Literal", ctx);
      json["literalType"] = "integer";
      json["value"] = ctx->INTEGER_LITERAL()->getText();
      return json;
    }

    if (ctx->castType() != nullptr) {
      return build_cast_type(ctx->castType());
    }

    throw ParsingError("Unsupported CAST type argument.", span_start(ctx), span_end(ctx));
  }

  Json build_cast_type(VoightParser::CastTypeContext* ctx) {
    Json json = node("CastType", ctx);
    json["name"] = build_qualified_name(ctx->qualifiedName());
    Json arguments = Json::array();
    arguments.reserveArray(ctx->castTypeArgument().size());
    for (auto* argument : ctx->castTypeArgument()) {
      arguments.pushBack(build_cast_type_argument(argument));
    }
    json["arguments"] = std::move(arguments);
    return json;
  }

  Json build_argument_list(VoightParser::ArgumentListContext* ctx) {
    Json arguments = Json::array();
    arguments.reserveArray(ctx->expression().size());
    for (auto* expression : ctx->expression()) {
      arguments.pushBack(build_expression(expression));
    }
    return arguments;
  }

  Json node(const string& kind, antlr4::ParserRuleContext* ctx) {
    Json json = Json::object();
    json.reserveObject(4);
    json["kind"] = kind;
    json["span"] = span_json(ctx);
    return json;
  }

  Json span_json(antlr4::ParserRuleContext* ctx) {
    Json span = Json::object();
    span.reserveObject(2);
    span["start"] = static_cast<int64_t>(span_start(ctx));
    span["end"] = static_cast<int64_t>(span_end(ctx));
    return span;
  }

  Json span_json(antlr4::Token* token) {
    Json span = Json::object();
    span.reserveObject(2);
    span["start"] = static_cast<int64_t>(span_start(token));
    span["end"] = static_cast<int64_t>(span_end(token));
    return span;
  }

  size_t span_start(antlr4::ParserRuleContext* ctx) {
    return ctx->getStart() != nullptr ? static_cast<size_t>(ctx->getStart()->getStartIndex()) : 0;
  }

  size_t span_end(antlr4::ParserRuleContext* ctx) {
    return ctx->getStop() != nullptr ? static_cast<size_t>(ctx->getStop()->getStopIndex() + 1) : 0;
  }

  size_t span_start(antlr4::Token* token) {
    return token != nullptr ? static_cast<size_t>(token->getStartIndex()) : 0;
  }

  size_t span_end(antlr4::Token* token) {
    return token != nullptr ? static_cast<size_t>(token->getStopIndex() + 1) : 0;
  }

  Json binary_expression(const string& op, const Json& left, const Json& right) {
    Json json = Json::object();
    json.reserveObject(5);
    json["kind"] = "BinaryExpression";
    json["operator"] = op == "<>" ? "!=" : op;
    json["left"] = left;
    json["right"] = right;
    json["span"] = merged_span(left, right);
    return json;
  }

  Json build_in_expression(
      antlr4::ParserRuleContext* ctx,
      const Json& operand,
      VoightParser::InPredicateContext* predicate,
      bool negated
  ) {
    if (predicate->queryExpression() != nullptr) {
      Json json = node("InSubqueryExpression", ctx);
      json["operand"] = operand;
      json["query"] = build_query_expression(predicate->queryExpression());
      json["negated"] = negated;
      return json;
    }

    Json json = node("InListExpression", ctx);
    json["operand"] = operand;
    Json values = Json::array();
    values.reserveArray(predicate->expression().size());
    for (auto* expression : predicate->expression()) {
      values.pushBack(build_expression(expression));
    }
    json["values"] = std::move(values);
    json["negated"] = negated;
    return json;
  }

  Json merged_span(const Json& left, const Json& right) {
    Json span = Json::object();
    span.reserveObject(2);
    span["start"] = span_offset(left, "start");
    span["end"] = span_offset(right, "end");
    return span;
  }

  int64_t span_offset(const Json& json, const string& key) {
    const Json* span = json.find("span");
    if (span == nullptr || !span->isObject()) {
      return 0;
    }
    const Json* value = span->find(key);
    if (value == nullptr) {
      return 0;
    }
    return value->getInt();
  }

  string comparison_operator_text(VoightParser::ComparisonOperatorContext* ctx) {
    if (ctx->EQ() != nullptr) {
      return "=";
    }
    if (ctx->NEQ() != nullptr) {
      return "!=";
    }
    if (ctx->LT() != nullptr) {
      return "<";
    }
    if (ctx->LTE() != nullptr) {
      return "<=";
    }
    if (ctx->GT() != nullptr) {
      return ">";
    }
    if (ctx->GTE() != nullptr) {
      return ">=";
    }
    if (ctx->LIKE() != nullptr) {
      return "LIKE";
    }
    throw ParsingError("Unsupported comparison operator.", span_start(ctx), span_end(ctx));
  }

  string decode_string_literal(const string& text) {
    if (text.size() < 2) {
      return text;
    }
    string value = text.substr(1, text.size() - 2);
    size_t offset = 0;
    while ((offset = value.find("''", offset)) != string::npos) {
      value.replace(offset, 2, "'");
      offset += 1;
    }
    return value;
  }

  string decode_quoted_identifier(const string& text) {
    if (text.size() < 2) {
      return text;
    }
    string value = text.substr(1, text.size() - 2);
    size_t offset = 0;
    while ((offset = value.find("``", offset)) != string::npos) {
      value.replace(offset, 2, "`");
      offset += 1;
    }
    return value;
  }

  void validate_quoted_identifier(const string& name, antlr4::ParserRuleContext* ctx) {
    if (name.empty()) {
      throw InvalidIdentifierError(
          "Quoted identifiers cannot be empty.", span_start(ctx), span_end(ctx));
    }

    for (const unsigned char character : name) {
      if (character < 0x20 || character > 0x7e) {
        throw InvalidIdentifierError(
            "Quoted identifiers must use printable ASCII characters only.",
            span_start(ctx),
            span_end(ctx));
      }
    }
  }

  string interval_unit_name(VoightParser::IntervalUnitContext* ctx) {
    if (ctx->SECOND() != nullptr) {
      return "SECOND";
    }
    if (ctx->MINUTE() != nullptr) {
      return "MINUTE";
    }
    if (ctx->HOUR() != nullptr) {
      return "HOUR";
    }
    if (ctx->DAY() != nullptr) {
      return "DAY";
    }
    if (ctx->WEEK() != nullptr) {
      return "WEEK";
    }
    if (ctx->MONTH() != nullptr) {
      return "MONTH";
    }
    if (ctx->QUARTER() != nullptr) {
      return "QUARTER";
    }
    if (ctx->YEAR() != nullptr) {
      return "YEAR";
    }

    throw ParsingError("Unsupported interval unit.", span_start(ctx), span_end(ctx));
  }
};

Json build_error_json(const string& type, const string& message, size_t start, size_t end) {
  Json json = Json::object();
  json.reserveObject(4);
  json["error"] = true;
  json["type"] = type;
  json["message"] = message;
  Json span = Json::object();
  span.reserveObject(2);
  span["start"] = static_cast<int64_t>(start);
  span["end"] = static_cast<int64_t>(end);
  json["span"] = std::move(span);
  return json;
}

Json parse_query_ast_or_throw(const string& input) {
  PreparedParse prepared(input);
  NativeAstBuilder builder;
  return builder.build_query(prepared.parse());
}

}  // namespace

std::string parse_query_json(const std::string& input) {
  try {
    return parse_query_ast_or_throw(input).dump();
  } catch (const UnsupportedConstructError& error) {
    return build_error_json("UnsupportedConstruct", error.what(), error.start, error.end).dump();
  } catch (const InvalidIdentifierError& error) {
    return build_error_json("InvalidIdentifier", error.what(), error.start, error.end).dump();
  } catch (const SyntaxError& error) {
    return build_error_json("SyntaxError", error.what(), error.start, error.end).dump();
  } catch (const ParsingError& error) {
    return build_error_json("ParsingError", error.what(), error.start, error.end).dump();
  } catch (const std::exception& error) {
    return build_error_json("ParsingError", error.what(), 0, input.size()).dump();
  } catch (...) {
    return build_error_json("ParsingError", "Native parser failed.", 0, input.size()).dump();
  }
}
