import { scope, type as arkType } from "arktype";

import type { SourceSpan } from "../core/source";

export interface AstNode<Kind extends string> {
    readonly kind: Kind;
    readonly span: SourceSpan;
}

export interface IdentifierNode extends AstNode<"Identifier"> {
    readonly name: string;
    readonly quoted: boolean;
}

export interface QualifiedNameNode extends AstNode<"QualifiedName"> {
    readonly parts: IdentifierNode[];
}

export interface QueryAst extends AstNode<"Query"> {
    readonly with?: WithClauseNode;
    readonly body: SelectStatementAst;
}

export interface WithClauseNode extends AstNode<"WithClause"> {
    readonly ctes: CommonTableExpressionNode[];
}

export interface CommonTableExpressionNode extends AstNode<"CommonTableExpression"> {
    readonly name: IdentifierNode;
    readonly columns: IdentifierNode[];
    readonly query: QueryAst;
}

export interface SelectStatementAst extends AstNode<"SelectStatement"> {
    readonly distinct: boolean;
    readonly selectItems: SelectItemNode[];
    readonly from?: TableReferenceNode;
    readonly joins: JoinNode[];
    readonly where?: ExpressionNode;
    readonly groupBy: ExpressionNode[];
    readonly having?: ExpressionNode;
    readonly orderBy: OrderByItemNode[];
    readonly limit?: LimitClauseNode;
}

export type SelectItemNode = SelectExpressionItemNode | SelectWildcardItemNode;

export interface SelectExpressionItemNode extends AstNode<"SelectExpressionItem"> {
    readonly expression: ExpressionNode;
    readonly alias?: IdentifierNode;
}

export interface SelectWildcardItemNode extends AstNode<"SelectWildcardItem"> {
    readonly qualifier?: IdentifierNode;
}

export type TableReferenceNode = NamedTableReferenceNode | DerivedTableReferenceNode;

export interface NamedTableReferenceNode extends AstNode<"TableReference"> {
    readonly name: QualifiedNameNode;
    readonly alias?: IdentifierNode;
}

export interface DerivedTableReferenceNode extends AstNode<"DerivedTableReference"> {
    readonly subquery: QueryAst;
    readonly alias: IdentifierNode;
}

export interface JoinNode extends AstNode<"Join"> {
    readonly joinType: "INNER" | "LEFT";
    readonly table: TableReferenceNode;
    readonly on: ExpressionNode;
}

export interface OrderByItemNode extends AstNode<"OrderByItem"> {
    readonly expression: ExpressionNode;
    readonly direction: "ASC" | "DESC";
}

export interface LimitClauseNode extends AstNode<"LimitClause"> {
    readonly count: ExpressionNode;
    readonly offset?: ExpressionNode;
}

export type ExpressionNode =
    | IdentifierExpressionNode
    | LiteralNode
    | ParameterNode
    | UnaryExpressionNode
    | BinaryExpressionNode
    | FunctionCallNode
    | CastExpressionNode
    | CaseExpressionNode
    | IntervalExpressionNode
    | QualifiedReferenceNode
    | GroupingExpressionNode
    | WildcardExpressionNode
    | IsNullExpressionNode
    | CurrentKeywordExpressionNode
    | BetweenExpressionNode
    | InListExpressionNode
    | InSubqueryExpressionNode
    | ExistsExpressionNode
    | ScalarSubqueryExpressionNode;

export interface IdentifierExpressionNode extends AstNode<"IdentifierExpression"> {
    readonly identifier: IdentifierNode;
}

export interface QualifiedReferenceNode extends AstNode<"QualifiedReference"> {
    readonly qualifier: IdentifierNode;
    readonly column: IdentifierNode;
}

export interface WildcardExpressionNode extends AstNode<"WildcardExpression"> {
    readonly qualifier?: IdentifierNode;
}

export type LiteralNode =
    | StringLiteralNode
    | IntegerLiteralNode
    | DecimalLiteralNode
    | BooleanLiteralNode
    | NullLiteralNode;

export interface StringLiteralNode extends AstNode<"Literal"> {
    readonly literalType: "string";
    readonly value: string;
}

export interface IntegerLiteralNode extends AstNode<"Literal"> {
    readonly literalType: "integer";
    readonly value: string;
}

export interface DecimalLiteralNode extends AstNode<"Literal"> {
    readonly literalType: "decimal";
    readonly value: string;
}

export interface BooleanLiteralNode extends AstNode<"Literal"> {
    readonly literalType: "boolean";
    readonly value: boolean;
}

export interface NullLiteralNode extends AstNode<"Literal"> {
    readonly literalType: "null";
    readonly value: null;
}

export interface ParameterNode extends AstNode<"Parameter"> {
    readonly index: number;
}

export interface UnaryExpressionNode extends AstNode<"UnaryExpression"> {
    readonly operator: "-" | "NOT";
    readonly operand: ExpressionNode;
}

export interface BinaryExpressionNode extends AstNode<"BinaryExpression"> {
    readonly operator:
        | "+"
        | "-"
        | "*"
        | "/"
        | "%"
        | "="
        | "!="
        | "<"
        | "<="
        | ">"
        | ">="
        | "LIKE"
        | "AND"
        | "OR";
    readonly left: ExpressionNode;
    readonly right: ExpressionNode;
}

export interface IsNullExpressionNode extends AstNode<"IsNullExpression"> {
    readonly operand: ExpressionNode;
    readonly negated: boolean;
}

export interface CurrentKeywordExpressionNode extends AstNode<"CurrentKeywordExpression"> {
    readonly keyword: "CURRENT_TIMESTAMP" | "CURRENT_DATE" | "CURRENT_TIME";
}

export interface BetweenExpressionNode extends AstNode<"BetweenExpression"> {
    readonly operand: ExpressionNode;
    readonly lower: ExpressionNode;
    readonly upper: ExpressionNode;
    readonly negated: boolean;
}

export interface InListExpressionNode extends AstNode<"InListExpression"> {
    readonly operand: ExpressionNode;
    readonly values: ExpressionNode[];
    readonly negated: boolean;
}

export interface InSubqueryExpressionNode extends AstNode<"InSubqueryExpression"> {
    readonly operand: ExpressionNode;
    readonly query: QueryAst;
    readonly negated: boolean;
}

export interface ExistsExpressionNode extends AstNode<"ExistsExpression"> {
    readonly query: QueryAst;
    readonly negated: boolean;
}

export interface ScalarSubqueryExpressionNode extends AstNode<"ScalarSubqueryExpression"> {
    readonly query: QueryAst;
}

export interface FunctionCallNode extends AstNode<"FunctionCall"> {
    readonly callee: IdentifierNode;
    readonly distinct: boolean;
    readonly arguments: ExpressionNode[];
    readonly over?: WindowSpecificationNode;
}

export interface WindowSpecificationNode extends AstNode<"WindowSpecification"> {
    readonly partitionBy: ExpressionNode[];
    readonly orderBy: OrderByItemNode[];
}

export interface CastExpressionNode extends AstNode<"CastExpression"> {
    readonly expression: ExpressionNode;
    readonly targetType: CastTypeNode;
}

export interface CaseExpressionNode extends AstNode<"CaseExpression"> {
    readonly operand?: ExpressionNode;
    readonly whenClauses: CaseWhenClauseNode[];
    readonly elseExpression?: ExpressionNode;
}

export interface CaseWhenClauseNode extends AstNode<"CaseWhenClause"> {
    readonly when: ExpressionNode;
    readonly then: ExpressionNode;
}

export interface IntervalExpressionNode extends AstNode<"IntervalExpression"> {
    readonly value: ExpressionNode;
    readonly unit: "SECOND" | "MINUTE" | "HOUR" | "DAY" | "WEEK" | "MONTH" | "QUARTER" | "YEAR";
}

export interface CastTypeNode extends AstNode<"CastType"> {
    readonly name: QualifiedNameNode;
    readonly arguments: CastTypeArgumentNode[];
}

export type CastTypeArgumentNode = IntegerLiteralNode | CastTypeNode;

export interface GroupingExpressionNode extends AstNode<"GroupingExpression"> {
    readonly expression: ExpressionNode;
}

const expressionNodeDefinition =
    "IdentifierExpressionNode | LiteralNode | ParameterNode | UnaryExpressionNode | BinaryExpressionNode | FunctionCallNode | CastExpressionNode | CaseExpressionNode | IntervalExpressionNode | QualifiedReferenceNode | GroupingExpressionNode | WildcardExpressionNode | IsNullExpressionNode | CurrentKeywordExpressionNode | BetweenExpressionNode | InListExpressionNode | InSubqueryExpressionNode | ExistsExpressionNode | ScalarSubqueryExpressionNode" as const;

const literalNodeDefinition =
    "StringLiteralNode | IntegerLiteralNode | DecimalLiteralNode | BooleanLiteralNode | NullLiteralNode" as const;

const queryAstScope = scope({
    SourceSpan: {
        start: "number.integer",
        end: "number.integer",
    },
    IdentifierNode: {
        kind: "'Identifier'",
        span: "SourceSpan",
        name: "string",
        quoted: "boolean",
    },
    QualifiedNameNode: {
        kind: "'QualifiedName'",
        span: "SourceSpan",
        parts: "IdentifierNode[]",
    },
    QueryAst: {
        kind: "'Query'",
        span: "SourceSpan",
        "with?": "WithClauseNode",
        body: "SelectStatementAst",
    },
    WithClauseNode: {
        kind: "'WithClause'",
        span: "SourceSpan",
        ctes: "CommonTableExpressionNode[]",
    },
    CommonTableExpressionNode: {
        kind: "'CommonTableExpression'",
        span: "SourceSpan",
        name: "IdentifierNode",
        columns: "IdentifierNode[]",
        query: "QueryAst",
    },
    SelectStatementAst: {
        kind: "'SelectStatement'",
        span: "SourceSpan",
        distinct: "boolean",
        selectItems: "SelectItemNode[]",
        "from?": "TableReferenceNode",
        joins: "JoinNode[]",
        "where?": "ExpressionNode",
        groupBy: "ExpressionNode[]",
        "having?": "ExpressionNode",
        orderBy: "OrderByItemNode[]",
        "limit?": "LimitClauseNode",
    },
    SelectItemNode: "SelectExpressionItemNode | SelectWildcardItemNode",
    SelectExpressionItemNode: {
        kind: "'SelectExpressionItem'",
        span: "SourceSpan",
        expression: "ExpressionNode",
        "alias?": "IdentifierNode",
    },
    SelectWildcardItemNode: {
        kind: "'SelectWildcardItem'",
        span: "SourceSpan",
        "qualifier?": "IdentifierNode",
    },
    TableReferenceNode: "NamedTableReferenceNode | DerivedTableReferenceNode",
    NamedTableReferenceNode: {
        kind: "'TableReference'",
        span: "SourceSpan",
        name: "QualifiedNameNode",
        "alias?": "IdentifierNode",
    },
    DerivedTableReferenceNode: {
        kind: "'DerivedTableReference'",
        span: "SourceSpan",
        subquery: "QueryAst",
        alias: "IdentifierNode",
    },
    JoinNode: {
        kind: "'Join'",
        span: "SourceSpan",
        joinType: "'INNER' | 'LEFT'",
        table: "TableReferenceNode",
        on: "ExpressionNode",
    },
    OrderByItemNode: {
        kind: "'OrderByItem'",
        span: "SourceSpan",
        expression: "ExpressionNode",
        direction: "'ASC' | 'DESC'",
    },
    LimitClauseNode: {
        kind: "'LimitClause'",
        span: "SourceSpan",
        count: "ExpressionNode",
        "offset?": "ExpressionNode",
    },
    ExpressionNode: expressionNodeDefinition,
    IdentifierExpressionNode: {
        kind: "'IdentifierExpression'",
        span: "SourceSpan",
        identifier: "IdentifierNode",
    },
    QualifiedReferenceNode: {
        kind: "'QualifiedReference'",
        span: "SourceSpan",
        qualifier: "IdentifierNode",
        column: "IdentifierNode",
    },
    WildcardExpressionNode: {
        kind: "'WildcardExpression'",
        span: "SourceSpan",
        "qualifier?": "IdentifierNode",
    },
    LiteralNode: literalNodeDefinition,
    StringLiteralNode: {
        kind: "'Literal'",
        span: "SourceSpan",
        literalType: "'string'",
        value: "string",
    },
    IntegerLiteralNode: {
        kind: "'Literal'",
        span: "SourceSpan",
        literalType: "'integer'",
        value: "string",
    },
    DecimalLiteralNode: {
        kind: "'Literal'",
        span: "SourceSpan",
        literalType: "'decimal'",
        value: "string",
    },
    BooleanLiteralNode: {
        kind: "'Literal'",
        span: "SourceSpan",
        literalType: "'boolean'",
        value: "boolean",
    },
    NullLiteralNode: {
        kind: "'Literal'",
        span: "SourceSpan",
        literalType: "'null'",
        value: "null",
    },
    ParameterNode: {
        kind: "'Parameter'",
        span: "SourceSpan",
        index: "number.integer",
    },
    UnaryExpressionNode: {
        kind: "'UnaryExpression'",
        span: "SourceSpan",
        operator: "'-' | 'NOT'",
        operand: "ExpressionNode",
    },
    BinaryExpressionNode: {
        kind: "'BinaryExpression'",
        span: "SourceSpan",
        operator:
            "'+' | '-' | '*' | '/' | '%' | '=' | '!=' | '<' | '<=' | '>' | '>=' | 'LIKE' | 'AND' | 'OR'",
        left: "ExpressionNode",
        right: "ExpressionNode",
    },
    IsNullExpressionNode: {
        kind: "'IsNullExpression'",
        span: "SourceSpan",
        operand: "ExpressionNode",
        negated: "boolean",
    },
    CurrentKeywordExpressionNode: {
        kind: "'CurrentKeywordExpression'",
        span: "SourceSpan",
        keyword: "'CURRENT_TIMESTAMP' | 'CURRENT_DATE' | 'CURRENT_TIME'",
    },
    BetweenExpressionNode: {
        kind: "'BetweenExpression'",
        span: "SourceSpan",
        operand: "ExpressionNode",
        lower: "ExpressionNode",
        upper: "ExpressionNode",
        negated: "boolean",
    },
    InListExpressionNode: {
        kind: "'InListExpression'",
        span: "SourceSpan",
        operand: "ExpressionNode",
        values: "ExpressionNode[]",
        negated: "boolean",
    },
    InSubqueryExpressionNode: {
        kind: "'InSubqueryExpression'",
        span: "SourceSpan",
        operand: "ExpressionNode",
        query: "QueryAst",
        negated: "boolean",
    },
    ExistsExpressionNode: {
        kind: "'ExistsExpression'",
        span: "SourceSpan",
        query: "QueryAst",
        negated: "boolean",
    },
    ScalarSubqueryExpressionNode: {
        kind: "'ScalarSubqueryExpression'",
        span: "SourceSpan",
        query: "QueryAst",
    },
    FunctionCallNode: {
        kind: "'FunctionCall'",
        span: "SourceSpan",
        callee: "IdentifierNode",
        distinct: "boolean",
        arguments: "ExpressionNode[]",
        "over?": "WindowSpecificationNode",
    },
    WindowSpecificationNode: {
        kind: "'WindowSpecification'",
        span: "SourceSpan",
        partitionBy: "ExpressionNode[]",
        orderBy: "OrderByItemNode[]",
    },
    CastExpressionNode: {
        kind: "'CastExpression'",
        span: "SourceSpan",
        expression: "ExpressionNode",
        targetType: "CastTypeNode",
    },
    CaseExpressionNode: {
        kind: "'CaseExpression'",
        span: "SourceSpan",
        "operand?": "ExpressionNode",
        whenClauses: "CaseWhenClauseNode[]",
        "elseExpression?": "ExpressionNode",
    },
    CaseWhenClauseNode: {
        kind: "'CaseWhenClause'",
        span: "SourceSpan",
        when: "ExpressionNode",
        then: "ExpressionNode",
    },
    IntervalExpressionNode: {
        kind: "'IntervalExpression'",
        span: "SourceSpan",
        value: "ExpressionNode",
        unit: "'SECOND' | 'MINUTE' | 'HOUR' | 'DAY' | 'WEEK' | 'MONTH' | 'QUARTER' | 'YEAR'",
    },
    CastTypeNode: {
        kind: "'CastType'",
        span: "SourceSpan",
        name: "QualifiedNameNode",
        arguments: "CastTypeArgumentNode[]",
    },
    CastTypeArgumentNode: "IntegerLiteralNode | CastTypeNode",
    GroupingExpressionNode: {
        kind: "'GroupingExpression'",
        span: "SourceSpan",
        expression: "ExpressionNode",
    },
}).export();

const queryAstSchema = queryAstScope.QueryAst;

export type QueryAstValidationResult =
    | { readonly ok: true; readonly value: QueryAst }
    | { readonly ok: false; readonly summary: string };

export function validateQueryAst(value: unknown): QueryAstValidationResult {
    const result = queryAstSchema(value);

    if (result instanceof arkType.errors) {
        return {
            ok: false,
            summary: result.summary,
        };
    }

    return {
        ok: true,
        value: result,
    };
}

// Type validation to avoid drift between the public AST types and the runtime schema.
// Necessary to keep ts emit small enough. Arktype generated types could not be serizalized.

type SchemaInferred<T> = T extends { infer: infer U } ? U : never;

type AstReadonly<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer U)[]
      ? AstReadonly<U>[]
      : T extends object
        ? { readonly [K in keyof T]: AstReadonly<T[K]> }
        : T;

type AstNodeType<T> = AstReadonly<SchemaInferred<T>>;

type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
            ? true
            : false
        : false;

type Assert<T extends true> = T;

// Keep the runtime schema aligned with the public AST types without leaking the huge schema type.
type _QueryAstSchemaMatchesType = Assert<
    Equal<AstNodeType<typeof queryAstScope.QueryAst>, QueryAst>
>;

const _queryAstSchemaMatchesType: _QueryAstSchemaMatchesType = true;
void _queryAstSchemaMatchesType;
