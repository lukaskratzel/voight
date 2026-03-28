import type { ColumnSchema, TableSchema } from "./catalog";
import type { SourceSpan } from "./source";

export interface AstNode {
    readonly kind: string;
    readonly span: SourceSpan;
}

export interface IdentifierNode extends AstNode {
    readonly kind: "Identifier";
    readonly name: string;
    readonly quoted: boolean;
}

export interface QualifiedNameNode extends AstNode {
    readonly kind: "QualifiedName";
    readonly parts: readonly IdentifierNode[];
}

export interface SelectStatementAst extends AstNode {
    readonly kind: "SelectStatement";
    readonly selectItems: readonly SelectItemNode[];
    readonly from?: TableReferenceNode;
    readonly joins: readonly JoinNode[];
    readonly where?: ExpressionNode;
    readonly groupBy: readonly ExpressionNode[];
    readonly having?: ExpressionNode;
    readonly orderBy: readonly OrderByItemNode[];
    readonly limit?: LimitClauseNode;
}

export type SelectItemNode = SelectExpressionItemNode | SelectWildcardItemNode;

export interface SelectExpressionItemNode extends AstNode {
    readonly kind: "SelectExpressionItem";
    readonly expression: ExpressionNode;
    readonly alias?: IdentifierNode;
}

export interface SelectWildcardItemNode extends AstNode {
    readonly kind: "SelectWildcardItem";
    readonly qualifier?: IdentifierNode;
}

export type TableReferenceNode = NamedTableReferenceNode | DerivedTableReferenceNode;

export interface NamedTableReferenceNode extends AstNode {
    readonly kind: "TableReference";
    readonly name: QualifiedNameNode;
    readonly alias?: IdentifierNode;
}

export interface DerivedTableReferenceNode extends AstNode {
    readonly kind: "DerivedTableReference";
    readonly subquery: SelectStatementAst;
    readonly alias: IdentifierNode;
}

export interface JoinNode extends AstNode {
    readonly kind: "Join";
    readonly joinType: "INNER" | "LEFT";
    readonly table: TableReferenceNode;
    readonly on: ExpressionNode;
}

export interface OrderByItemNode extends AstNode {
    readonly kind: "OrderByItem";
    readonly expression: ExpressionNode;
    readonly direction: "ASC" | "DESC";
}

export interface LimitClauseNode extends AstNode {
    readonly kind: "LimitClause";
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
    | QualifiedReferenceNode
    | GroupingExpressionNode
    | WildcardExpressionNode
    | IsNullExpressionNode
    | CurrentKeywordExpressionNode
    | InListExpressionNode;

export interface IdentifierExpressionNode extends AstNode {
    readonly kind: "IdentifierExpression";
    readonly identifier: IdentifierNode;
}

export interface QualifiedReferenceNode extends AstNode {
    readonly kind: "QualifiedReference";
    readonly qualifier: IdentifierNode;
    readonly column: IdentifierNode;
}

export interface WildcardExpressionNode extends AstNode {
    readonly kind: "WildcardExpression";
    readonly qualifier?: IdentifierNode;
}

export interface LiteralNode extends AstNode {
    readonly kind: "Literal";
    readonly literalType: "string" | "integer" | "decimal" | "boolean" | "null";
    readonly value: string | boolean | null;
}

export interface ParameterNode extends AstNode {
    readonly kind: "Parameter";
    readonly index: number;
}

export interface UnaryExpressionNode extends AstNode {
    readonly kind: "UnaryExpression";
    readonly operator: "-" | "NOT";
    readonly operand: ExpressionNode;
}

export interface BinaryExpressionNode extends AstNode {
    readonly kind: "BinaryExpression";
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
        | "AND"
        | "OR";
    readonly left: ExpressionNode;
    readonly right: ExpressionNode;
}

export interface IsNullExpressionNode extends AstNode {
    readonly kind: "IsNullExpression";
    readonly operand: ExpressionNode;
    readonly negated: boolean;
}

export interface CurrentKeywordExpressionNode extends AstNode {
    readonly kind: "CurrentKeywordExpression";
    readonly keyword: "CURRENT_TIMESTAMP" | "CURRENT_DATE" | "CURRENT_TIME";
}

export interface InListExpressionNode extends AstNode {
    readonly kind: "InListExpression";
    readonly operand: ExpressionNode;
    readonly values: readonly ExpressionNode[];
    readonly negated: boolean;
}

export interface FunctionCallNode extends AstNode {
    readonly kind: "FunctionCall";
    readonly callee: IdentifierNode;
    readonly arguments: readonly ExpressionNode[];
}

export interface BoundSelectStatement extends AstNode {
    readonly kind: "BoundSelectStatement";
    readonly ast: SelectStatementAst;
    readonly selectItems: readonly BoundSelectItem[];
    readonly from?: BoundTableReference;
    readonly joins: readonly BoundJoin[];
    readonly where?: BoundExpression;
    readonly groupBy: readonly BoundExpression[];
    readonly having?: BoundExpression;
    readonly orderBy: readonly BoundOrderByItem[];
    readonly limit?: BoundLimitClause;
    readonly scope: BoundScope;
}

export type BoundSelectItem = BoundSelectExpressionItem | BoundSelectWildcardItem;

export interface BoundSelectExpressionItem extends AstNode {
    readonly kind: "BoundSelectExpressionItem";
    readonly ast: SelectExpressionItemNode;
    readonly expression: BoundExpression;
    readonly alias?: string;
}

export interface BoundSelectWildcardItem extends AstNode {
    readonly kind: "BoundSelectWildcardItem";
    readonly ast: SelectWildcardItemNode;
    readonly table?: BoundTableReference;
}

export interface BoundTableReference extends AstNode {
    readonly kind: "BoundTableReference";
    readonly ast: TableReferenceNode;
    readonly table: TableSchema;
    readonly alias: string;
    readonly source: "catalog" | "derived";
    readonly subquery?: BoundSelectStatement;
}

export interface BoundJoin extends AstNode {
    readonly kind: "BoundJoin";
    readonly ast: JoinNode;
    readonly joinType: "INNER" | "LEFT";
    readonly table: BoundTableReference;
    readonly on: BoundExpression;
}

export interface BoundOrderByItem extends AstNode {
    readonly kind: "BoundOrderByItem";
    readonly ast: OrderByItemNode;
    readonly expression: BoundExpression;
    readonly direction: "ASC" | "DESC";
}

export interface BoundLimitClause extends AstNode {
    readonly kind: "BoundLimitClause";
    readonly ast: LimitClauseNode;
    readonly count: BoundExpression;
    readonly offset?: BoundExpression;
}

export interface BoundScope {
    readonly tables: ReadonlyMap<string, BoundTableReference>;
}

export type BoundExpression =
    | BoundLiteral
    | BoundParameter
    | BoundUnaryExpression
    | BoundBinaryExpression
    | BoundFunctionCall
    | BoundColumnReference
    | BoundGroupingExpression
    | BoundWildcardExpression
    | BoundIsNullExpression
    | BoundCurrentKeywordExpression
    | BoundInListExpression;

export interface BoundLiteral extends AstNode {
    readonly kind: "BoundLiteral";
    readonly ast: LiteralNode;
    readonly literalType: LiteralNode["literalType"];
    readonly value: LiteralNode["value"];
}

export interface BoundParameter extends AstNode {
    readonly kind: "BoundParameter";
    readonly ast: ParameterNode;
    readonly index: number;
}

export interface BoundUnaryExpression extends AstNode {
    readonly kind: "BoundUnaryExpression";
    readonly ast: UnaryExpressionNode;
    readonly operator: UnaryExpressionNode["operator"];
    readonly operand: BoundExpression;
}

export interface BoundBinaryExpression extends AstNode {
    readonly kind: "BoundBinaryExpression";
    readonly ast: BinaryExpressionNode;
    readonly operator: BinaryExpressionNode["operator"];
    readonly left: BoundExpression;
    readonly right: BoundExpression;
}

export interface BoundFunctionCall extends AstNode {
    readonly kind: "BoundFunctionCall";
    readonly ast: FunctionCallNode;
    readonly callee: string;
    readonly arguments: readonly BoundExpression[];
}

export interface BoundColumnReference extends AstNode {
    readonly kind: "BoundColumnReference";
    readonly ast: IdentifierExpressionNode | QualifiedReferenceNode;
    readonly table: BoundTableReference;
    readonly column: ColumnSchema;
}

export interface BoundGroupingExpression extends AstNode {
    readonly kind: "BoundGroupingExpression";
    readonly ast: GroupingExpressionNode;
    readonly expression: BoundExpression;
}

export interface GroupingExpressionNode extends AstNode {
    readonly kind: "GroupingExpression";
    readonly expression: ExpressionNode;
}

export interface BoundWildcardExpression extends AstNode {
    readonly kind: "BoundWildcardExpression";
    readonly ast: WildcardExpressionNode;
    readonly table?: BoundTableReference;
}

export interface BoundIsNullExpression extends AstNode {
    readonly kind: "BoundIsNullExpression";
    readonly ast: IsNullExpressionNode;
    readonly operand: BoundExpression;
    readonly negated: boolean;
}

export interface BoundCurrentKeywordExpression extends AstNode {
    readonly kind: "BoundCurrentKeywordExpression";
    readonly ast: CurrentKeywordExpressionNode;
    readonly keyword: CurrentKeywordExpressionNode["keyword"];
}

export interface BoundInListExpression extends AstNode {
    readonly kind: "BoundInListExpression";
    readonly ast: InListExpressionNode;
    readonly operand: BoundExpression;
    readonly values: readonly BoundExpression[];
    readonly negated: boolean;
}
