import {
    type BinaryExpressionNode,
    type CommonTableExpressionNode,
    type CurrentKeywordExpressionNode,
    type DerivedTableReferenceNode,
    type ExistsExpressionNode,
    type ExpressionNode,
    type FunctionCallNode,
    type GroupingExpressionNode,
    type IdentifierExpressionNode,
    type IdentifierNode,
    type InListExpressionNode,
    type InSubqueryExpressionNode,
    type IsNullExpressionNode,
    type JoinNode,
    type LimitClauseNode,
    type LiteralNode,
    type OrderByItemNode,
    type ParameterNode,
    type QualifiedNameNode,
    type QualifiedReferenceNode,
    type QueryAst,
    type ScalarSubqueryExpressionNode,
    type SelectExpressionItemNode,
    type SelectItemNode,
    type SelectStatementAst,
    type SelectWildcardItemNode,
    type TableReferenceNode,
    type UnaryExpressionNode,
    type WildcardExpressionNode,
    type WithClauseNode,
} from "./ast";
import { CompilerStage, DiagnosticCode, createDiagnostic } from "./diagnostics";
import { stageFailure, stageSuccess, type StageResult } from "./result";
import { mergeSpans } from "./source";
import type { Token, TokenStream } from "./lexer";

export type ParseResult<T> = StageResult<T, CompilerStage.Parser, { tokenIndex: number }>;

export function parse(tokens: TokenStream): ParseResult<QueryAst> {
    const parser = new Parser(tokens);
    return parser.parse();
}

class Parser {
    readonly #tokens: readonly Token[];
    #index = 0;

    constructor(stream: TokenStream) {
        this.#tokens = stream.tokens;
    }

    parse(): ParseResult<QueryAst> {
        try {
            const query = this.parseQuery();
            if (this.consume("semicolon")) {
                this.expect("eof");
            } else {
                this.expect("eof");
            }

            return stageSuccess(CompilerStage.Parser, query, {
                tokenIndex: this.#index,
            });
        } catch (error) {
            const diagnostic =
                error instanceof ParserDiagnosticError
                    ? error.diagnostic
                    : createDiagnostic({
                          code: DiagnosticCode.UnexpectedToken,
                          stage: CompilerStage.Parser,
                          message: "Unexpected parser failure.",
                          primarySpan: this.current().span,
                      });

            return stageFailure(CompilerStage.Parser, [diagnostic], {
                tokenIndex: this.#index,
            });
        }
    }

    parseQuery(): QueryAst {
        const withClause = this.matchKeyword("WITH") ? this.parseWithClause() : undefined;
        const body = this.parseSelectStatement();
        return {
            kind: "Query",
            span: withClause ? mergeSpans(withClause.span, body.span) : body.span,
            with: withClause,
            body,
        };
    }

    parseWithClause(): WithClauseNode {
        const withToken = this.expectKeyword("WITH");
        const ctes: CommonTableExpressionNode[] = [this.parseCommonTableExpression()];
        while (this.consume("comma")) {
            ctes.push(this.parseCommonTableExpression());
        }

        return {
            kind: "WithClause",
            span: mergeSpans(withToken.span, ctes[ctes.length - 1]!.span),
            ctes,
        };
    }

    parseCommonTableExpression(): CommonTableExpressionNode {
        const name = this.parseIdentifier();
        const columns = this.parseOptionalColumnList();
        this.expectKeyword("AS");
        this.expect("left_paren");
        const query = this.parseQuery();
        const end = this.expect("right_paren");

        return {
            kind: "CommonTableExpression",
            span: mergeSpans(name.span, end.span),
            name,
            columns,
            query,
        };
    }

    parseOptionalColumnList(): readonly IdentifierNode[] {
        if (!this.consume("left_paren")) {
            return [];
        }

        const columns = [this.parseIdentifier()];
        while (this.consume("comma")) {
            columns.push(this.parseIdentifier());
        }
        this.expect("right_paren");
        return columns;
    }

    parseSelectStatement(): SelectStatementAst {
        const selectToken = this.expectKeyword("SELECT");
        const selectItems = this.parseSelectList();
        const joins: JoinNode[] = [];
        const from = this.consumeKeyword("FROM") ? this.parseTableReference() : undefined;

        while (
            from &&
            (this.matchKeyword("INNER") || this.matchKeyword("LEFT") || this.matchKeyword("JOIN"))
        ) {
            joins.push(this.parseJoin());
        }

        const where = this.consumeKeyword("WHERE") ? this.parseExpression() : undefined;
        const groupBy = this.consumeKeyword("GROUP") ? this.parseGroupBy() : [];
        const having = this.consumeKeyword("HAVING") ? this.parseExpression() : undefined;
        const orderBy = this.consumeKeyword("ORDER") ? this.parseOrderBy() : [];
        const limit = this.consumeKeyword("LIMIT") ? this.parseLimitClause() : undefined;
        const endSpan =
            limit?.span ??
            orderBy.at(-1)?.span ??
            having?.span ??
            groupBy.at(-1)?.span ??
            where?.span ??
            joins.at(-1)?.span ??
            from?.span ??
            selectItems.at(-1)?.span ??
            selectToken.span;

        return {
            kind: "SelectStatement",
            span: mergeSpans(selectToken.span, endSpan),
            selectItems,
            from,
            joins,
            where,
            groupBy,
            having,
            orderBy,
            limit,
        };
    }

    parseSelectList(): readonly SelectItemNode[] {
        const items: SelectItemNode[] = [this.parseSelectItem()];
        while (this.consume("comma")) {
            items.push(this.parseSelectItem());
        }
        return items;
    }

    parseSelectItem(): SelectItemNode {
        const current = this.current();
        if (current.kind === "asterisk") {
            this.advance();
            return {
                kind: "SelectWildcardItem",
                span: current.span,
            };
        }

        if (
            current.kind === "identifier" &&
            this.peek(1).kind === "dot" &&
            this.peek(2).kind === "asterisk"
        ) {
            const qualifier = this.parseIdentifier();
            this.expect("dot");
            const star = this.expect("asterisk");
            return {
                kind: "SelectWildcardItem",
                qualifier,
                span: mergeSpans(qualifier.span, star.span),
            } satisfies SelectWildcardItemNode;
        }

        const expression = this.parseExpression();
        const alias = this.parseOptionalAlias();
        return {
            kind: "SelectExpressionItem",
            span: alias ? mergeSpans(expression.span, alias.span) : expression.span,
            expression,
            alias,
        } satisfies SelectExpressionItemNode;
    }

    parseOptionalAlias(): IdentifierNode | undefined {
        if (this.consumeKeyword("AS")) {
            return this.parseIdentifier();
        }

        const current = this.current();
        if (current.kind === "identifier") {
            this.advance();
            return {
                kind: "Identifier",
                span: current.span,
                name: current.text,
                quoted: current.quoted ?? false,
            };
        }

        return undefined;
    }

    parseTableReference(): TableReferenceNode {
        if (this.consume("left_paren")) {
            const start = this.previous().span;
            const query = this.parseQuery();
            this.expect("right_paren");
            const alias = this.parseRequiredAlias();

            return {
                kind: "DerivedTableReference",
                span: mergeSpans(start, alias.span),
                subquery: query,
                alias,
            } satisfies DerivedTableReferenceNode;
        }

        const name = this.parseQualifiedName();
        const alias = this.parseOptionalAlias();

        return {
            kind: "TableReference",
            span: alias ? mergeSpans(name.span, alias.span) : name.span,
            name,
            alias,
        };
    }

    parseJoin(): JoinNode {
        let joinType: "INNER" | "LEFT" = "INNER";
        const start = this.current().span;

        if (this.consumeKeyword("INNER")) {
            this.expectKeyword("JOIN");
        } else if (this.consumeKeyword("LEFT")) {
            joinType = "LEFT";
            this.expectKeyword("JOIN");
        } else {
            this.expectKeyword("JOIN");
        }

        const table = this.parseTableReference();
        this.expectKeyword("ON");
        const on = this.parseExpression();

        return {
            kind: "Join",
            span: mergeSpans(start, on.span),
            joinType,
            table,
            on,
        };
    }

    parseGroupBy(): readonly ExpressionNode[] {
        this.expectKeyword("BY");
        const values: ExpressionNode[] = [this.parseExpression()];
        while (this.consume("comma")) {
            values.push(this.parseExpression());
        }
        return values;
    }

    parseOrderBy(): readonly OrderByItemNode[] {
        this.expectKeyword("BY");
        const items = [this.parseOrderByItem()];
        while (this.consume("comma")) {
            items.push(this.parseOrderByItem());
        }
        return items;
    }

    parseOrderByItem(): OrderByItemNode {
        const expression = this.parseExpression();
        let direction: "ASC" | "DESC" = "ASC";

        if (this.consumeKeyword("ASC")) {
            direction = "ASC";
        } else if (this.consumeKeyword("DESC")) {
            direction = "DESC";
        }

        return {
            kind: "OrderByItem",
            span: expression.span,
            expression,
            direction,
        };
    }

    parseLimitClause(): LimitClauseNode {
        const first = this.parseExpression();
        let count = first;
        let offset: ExpressionNode | undefined;

        if (this.consume("comma")) {
            offset = first;
            count = this.parseExpression();
        } else if (this.consumeKeyword("OFFSET")) {
            offset = this.parseExpression();
        }

        return {
            kind: "LimitClause",
            span: offset ? mergeSpans(first.span, offset.span) : first.span,
            count,
            offset,
        };
    }

    parseExpression(): ExpressionNode {
        return this.parseOrExpression();
    }

    parseOrExpression(): ExpressionNode {
        let expression = this.parseAndExpression();
        while (this.consumeKeyword("OR")) {
            const right = this.parseAndExpression();
            expression = {
                kind: "BinaryExpression",
                span: mergeSpans(expression.span, right.span),
                operator: "OR",
                left: expression,
                right,
            } satisfies BinaryExpressionNode;
        }
        return expression;
    }

    parseAndExpression(): ExpressionNode {
        let expression = this.parseComparisonExpression();
        while (this.consumeKeyword("AND")) {
            const right = this.parseComparisonExpression();
            expression = {
                kind: "BinaryExpression",
                span: mergeSpans(expression.span, right.span),
                operator: "AND",
                left: expression,
                right,
            } satisfies BinaryExpressionNode;
        }
        return expression;
    }

    parseComparisonExpression(): ExpressionNode {
        let expression = this.parseAdditiveExpression();

        if (this.consumeKeyword("IS")) {
            const negated = this.consumeKeyword("NOT");
            this.expectKeyword("NULL");
            return {
                kind: "IsNullExpression",
                span: expression.span,
                operand: expression,
                negated,
            } satisfies IsNullExpressionNode;
        }

        if (this.consumeKeyword("IN")) {
            return this.parseInPredicate(expression, false);
        }

        if (this.consumeKeyword("NOT")) {
            if (this.consumeKeyword("IN")) {
                return this.parseInPredicate(expression, true);
            }

            throw this.error(
                DiagnosticCode.UnsupportedConstruct,
                'Only "NOT IN (...)" is supported after an expression in this parser position.',
                this.previous().span,
            );
        }

        const operator = this.current();
        if (
            operator.kind === "operator" &&
            ["=", "!=", "<>", "<", "<=", ">", ">="].includes(operator.text)
        ) {
            this.advance();
            const right = this.parseAdditiveExpression();
            return {
                kind: "BinaryExpression",
                span: mergeSpans(expression.span, right.span),
                operator:
                    operator.text === "<>"
                        ? "!="
                        : (operator.text as BinaryExpressionNode["operator"]),
                left: expression,
                right,
            };
        }

        return expression;
    }

    parseInPredicate(operand: ExpressionNode, negated: boolean): ExpressionNode {
        this.expect("left_paren");
        if (this.isQueryStart()) {
            const query = this.parseQuery();
            const end = this.expect("right_paren");
            return {
                kind: "InSubqueryExpression",
                span: mergeSpans(operand.span, end.span),
                operand,
                query,
                negated,
            } satisfies InSubqueryExpressionNode;
        }

        const values: ExpressionNode[] = [this.parseExpression()];
        while (this.consume("comma")) {
            values.push(this.parseExpression());
        }
        const end = this.expect("right_paren");
        return {
            kind: "InListExpression",
            span: mergeSpans(operand.span, end.span),
            operand,
            values,
            negated,
        } satisfies InListExpressionNode;
    }

    parseAdditiveExpression(): ExpressionNode {
        let expression = this.parseMultiplicativeExpression();
        while (
            this.current().kind === "operator" &&
            (this.current().text === "+" || this.current().text === "-")
        ) {
            const operator = this.current();
            this.advance();
            const right = this.parseMultiplicativeExpression();
            expression = {
                kind: "BinaryExpression",
                span: mergeSpans(expression.span, right.span),
                operator: operator.text as BinaryExpressionNode["operator"],
                left: expression,
                right,
            };
        }
        return expression;
    }

    parseMultiplicativeExpression(): ExpressionNode {
        let expression = this.parseUnaryExpression();
        while (
            (this.current().kind === "operator" && ["/", "%"].includes(this.current().text)) ||
            this.current().kind === "asterisk"
        ) {
            const operator = this.current();
            this.advance();
            const right = this.parseUnaryExpression();
            expression = {
                kind: "BinaryExpression",
                span: mergeSpans(expression.span, right.span),
                operator: (operator.kind === "asterisk"
                    ? "*"
                    : operator.text) as BinaryExpressionNode["operator"],
                left: expression,
                right,
            };
        }
        return expression;
    }

    parseUnaryExpression(): ExpressionNode {
        if (this.current().kind === "operator" && this.current().text === "-") {
            const start = this.current().span;
            this.advance();
            const operand = this.parseUnaryExpression();
            return {
                kind: "UnaryExpression",
                span: mergeSpans(start, operand.span),
                operator: "-",
                operand,
            } satisfies UnaryExpressionNode;
        }

        if (this.consumeKeyword("NOT")) {
            if (this.consumeKeyword("EXISTS")) {
                const query = this.parseParenthesizedQuery();
                return {
                    kind: "ExistsExpression",
                    span: mergeSpans(this.previous().span, query.span),
                    query,
                    negated: true,
                } satisfies ExistsExpressionNode;
            }

            const operand = this.parseUnaryExpression();
            return {
                kind: "UnaryExpression",
                span: operand.span,
                operator: "NOT",
                operand,
            } satisfies UnaryExpressionNode;
        }

        if (this.consumeKeyword("EXISTS")) {
            const existsToken = this.previous();
            const query = this.parseParenthesizedQuery();
            return {
                kind: "ExistsExpression",
                span: mergeSpans(existsToken.span, query.span),
                query,
                negated: false,
            } satisfies ExistsExpressionNode;
        }

        return this.parsePrimaryExpression();
    }

    parsePrimaryExpression(): ExpressionNode {
        const current = this.current();

        if (current.kind === "left_paren") {
            const start = current.span;
            this.advance();

            if (this.isQueryStart()) {
                const query = this.parseQuery();
                const end = this.expect("right_paren");
                return {
                    kind: "ScalarSubqueryExpression",
                    span: mergeSpans(start, end.span),
                    query,
                } satisfies ScalarSubqueryExpressionNode;
            }

            const expression = this.parseExpression();
            const end = this.expect("right_paren");
            return {
                kind: "GroupingExpression",
                span: mergeSpans(start, end.span),
                expression,
            } satisfies GroupingExpressionNode;
        }

        if (current.kind === "number") {
            this.advance();
            return createNumericLiteral(current);
        }

        if (current.kind === "string") {
            this.advance();
            return {
                kind: "Literal",
                span: current.span,
                literalType: "string",
                value: decodeStringLiteral(current.text),
            } satisfies LiteralNode;
        }

        if (current.kind === "parameter") {
            this.advance();
            return {
                kind: "Parameter",
                span: current.span,
                index: current.span.start,
            } satisfies ParameterNode;
        }

        if (
            current.kind === "keyword" &&
            (current.keyword === "TRUE" || current.keyword === "FALSE")
        ) {
            this.advance();
            return {
                kind: "Literal",
                span: current.span,
                literalType: "boolean",
                value: current.keyword === "TRUE",
            } satisfies LiteralNode;
        }

        if (current.kind === "keyword" && current.keyword === "NULL") {
            this.advance();
            return {
                kind: "Literal",
                span: current.span,
                literalType: "null",
                value: null,
            } satisfies LiteralNode;
        }

        if (
            current.kind === "keyword" &&
            (current.keyword === "CURRENT_TIMESTAMP" ||
                current.keyword === "CURRENT_DATE" ||
                current.keyword === "CURRENT_TIME")
        ) {
            this.advance();
            return {
                kind: "CurrentKeywordExpression",
                span: current.span,
                keyword: current.keyword,
            } satisfies CurrentKeywordExpressionNode;
        }

        if (current.kind === "asterisk") {
            this.advance();
            return {
                kind: "WildcardExpression",
                span: current.span,
            } satisfies WildcardExpressionNode;
        }

        if (current.kind === "identifier") {
            const identifier = this.parseIdentifier();
            if (this.consume("left_paren")) {
                const args: ExpressionNode[] = [];
                if (!this.consume("right_paren")) {
                    args.push(this.parseExpression());
                    while (this.consume("comma")) {
                        args.push(this.parseExpression());
                    }
                    this.expect("right_paren");
                }

                return {
                    kind: "FunctionCall",
                    span: mergeSpans(identifier.span, this.previous().span),
                    callee: identifier,
                    arguments: args,
                } satisfies FunctionCallNode;
            }

            if (this.consume("dot")) {
                const next = this.current();
                if (next.kind === "asterisk") {
                    this.advance();
                    return {
                        kind: "WildcardExpression",
                        span: mergeSpans(identifier.span, next.span),
                        qualifier: identifier,
                    } satisfies WildcardExpressionNode;
                }

                const column = this.parseIdentifier();
                return {
                    kind: "QualifiedReference",
                    span: mergeSpans(identifier.span, column.span),
                    qualifier: identifier,
                    column,
                } satisfies QualifiedReferenceNode;
            }

            return {
                kind: "IdentifierExpression",
                span: identifier.span,
                identifier,
            } satisfies IdentifierExpressionNode;
        }

        if (current.kind === "keyword") {
            throw this.error(
                DiagnosticCode.UnsupportedConstruct,
                `Keyword "${current.keyword}" is not supported in this expression position.`,
                current.span,
            );
        }

        throw this.error(
            DiagnosticCode.UnexpectedToken,
            `Unexpected token "${current.text || current.kind}".`,
            current.span,
        );
    }

    parseParenthesizedQuery(): QueryAst {
        const start = this.expect("left_paren");
        const query = this.parseQuery();
        const end = this.expect("right_paren");
        return {
            ...query,
            span: mergeSpans(start.span, end.span),
        };
    }

    parseQualifiedName(): QualifiedNameNode {
        const parts = [this.parseIdentifier()];
        while (this.consume("dot")) {
            parts.push(this.parseIdentifier());
        }

        return {
            kind: "QualifiedName",
            span: mergeSpans(parts[0]!.span, parts[parts.length - 1]!.span),
            parts,
        };
    }

    parseIdentifier(): IdentifierNode {
        const current = this.current();
        if (current.kind !== "identifier") {
            throw this.error(
                current.kind === "eof"
                    ? DiagnosticCode.UnexpectedEndOfInput
                    : current.kind === "keyword"
                      ? DiagnosticCode.UnsupportedConstruct
                      : DiagnosticCode.UnexpectedToken,
                `Expected identifier but found "${current.text || current.kind}".`,
                current.span,
            );
        }

        this.advance();
        return {
            kind: "Identifier",
            span: current.span,
            name: current.text,
            quoted: current.quoted ?? false,
        };
    }

    parseRequiredAlias(): IdentifierNode {
        if (this.consumeKeyword("AS")) {
            return this.parseIdentifier();
        }

        return this.parseIdentifier();
    }

    isQueryStart(): boolean {
        return (
            (this.current().kind === "keyword" && this.current().keyword === "SELECT") ||
            (this.current().kind === "keyword" && this.current().keyword === "WITH")
        );
    }

    current(): Token {
        return this.#tokens[this.#index] ?? this.#tokens[this.#tokens.length - 1]!;
    }

    previous(): Token {
        return this.#tokens[Math.max(0, this.#index - 1)]!;
    }

    peek(distance: number): Token {
        return this.#tokens[Math.min(this.#tokens.length - 1, this.#index + distance)]!;
    }

    advance(): void {
        this.#index += 1;
    }

    consume(kind: Token["kind"]): boolean {
        if (this.current().kind !== kind) {
            return false;
        }

        this.advance();
        return true;
    }

    consumeKeyword(keyword: string): boolean {
        const current = this.current();
        if (current.kind !== "keyword" || current.keyword !== keyword) {
            return false;
        }

        this.advance();
        return true;
    }

    matchKeyword(keyword: string): boolean {
        const current = this.current();
        return current.kind === "keyword" && current.keyword === keyword;
    }

    expect(kind: Token["kind"]): Token {
        const current = this.current();
        if (current.kind !== kind) {
            throw this.errorForExpectation(
                `Expected ${kind} but found "${current.text || current.kind}".`,
                current,
            );
        }
        this.advance();
        return current;
    }

    expectKeyword(keyword: string): Token {
        const current = this.current();
        if (current.kind !== "keyword" || current.keyword !== keyword) {
            if (current.kind === "eof") {
                throw this.error(
                    DiagnosticCode.UnexpectedEndOfInput,
                    `Expected keyword "${keyword}" but reached end of input.`,
                    current.span,
                );
            }

            throw this.error(
                current.kind === "keyword"
                    ? DiagnosticCode.UnsupportedStatement
                    : DiagnosticCode.UnexpectedToken,
                `Expected keyword "${keyword}" but found "${current.text || current.kind}".`,
                current.span,
            );
        }

        this.advance();
        return current;
    }

    errorForExpectation(message: string, token: Token): ParserDiagnosticError {
        return this.error(
            token.kind === "eof"
                ? DiagnosticCode.UnexpectedEndOfInput
                : DiagnosticCode.UnexpectedToken,
            message,
            token.span,
        );
    }

    error(code: DiagnosticCode, message: string, span: Token["span"]): ParserDiagnosticError {
        return new ParserDiagnosticError(
            createDiagnostic({
                code,
                stage: CompilerStage.Parser,
                message,
                primarySpan: span,
            }),
        );
    }
}

class ParserDiagnosticError extends Error {
    readonly diagnostic;

    constructor(diagnostic: ReturnType<typeof createDiagnostic>) {
        super(diagnostic.message);
        this.diagnostic = diagnostic;
    }
}

function createNumericLiteral(token: Token): LiteralNode {
    return {
        kind: "Literal",
        span: token.span,
        literalType: token.text.includes(".") ? "decimal" : "integer",
        value: token.text,
    };
}

function decodeStringLiteral(text: string): string {
    return text.slice(1, -1).replace(/''/g, "'");
}
