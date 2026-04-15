import type { ColumnSchema, TableSchema } from "../catalog";
import type {
    BinaryExpressionNode,
    CaseExpressionNode,
    CaseWhenClauseNode,
    CastExpressionNode,
    CastTypeNode,
    CommonTableExpressionNode,
    CurrentKeywordExpressionNode,
    ExistsExpressionNode,
    FunctionCallNode,
    GroupingExpressionNode,
    IdentifierExpressionNode,
    InListExpressionNode,
    InSubqueryExpressionNode,
    IntervalExpressionNode,
    IsNullExpressionNode,
    JoinNode,
    LimitClauseNode,
    LiteralNode,
    ParameterNode,
    QualifiedReferenceNode,
    QueryAst,
    ScalarSubqueryExpressionNode,
    SelectExpressionItemNode,
    SelectStatementAst,
    SelectWildcardItemNode,
    TableReferenceNode,
    UnaryExpressionNode,
    WildcardExpressionNode,
    WithClauseNode,
    OrderByItemNode,
} from "./query-ast-schema";
import type { SourceSpan } from "../core/source";

export type {
    BinaryExpressionNode,
    CaseExpressionNode,
    CaseWhenClauseNode,
    CastExpressionNode,
    CastTypeArgumentNode,
    CastTypeNode,
    CommonTableExpressionNode,
    CurrentKeywordExpressionNode,
    DerivedTableReferenceNode,
    ExistsExpressionNode,
    ExpressionNode,
    FunctionCallNode,
    GroupingExpressionNode,
    IdentifierExpressionNode,
    IdentifierNode,
    InListExpressionNode,
    InSubqueryExpressionNode,
    IntervalExpressionNode,
    IsNullExpressionNode,
    JoinNode,
    LimitClauseNode,
    LiteralNode,
    NamedTableReferenceNode,
    ParameterNode,
    QualifiedNameNode,
    QualifiedReferenceNode,
    QueryAst,
    ScalarSubqueryExpressionNode,
    SelectExpressionItemNode,
    SelectItemNode,
    SelectStatementAst,
    SelectWildcardItemNode,
    TableReferenceNode,
    UnaryExpressionNode,
    WildcardExpressionNode,
    WithClauseNode,
    OrderByItemNode,
} from "./query-ast-schema";

export interface AstNode {
    readonly kind: string;
    readonly span: SourceSpan;
}

export interface BoundQuery extends AstNode {
    readonly kind: "BoundQuery";
    readonly ast: QueryAst;
    readonly with?: BoundWithClause;
    readonly body: BoundSelectStatement;
    readonly output: readonly BoundOutputColumn[];
}

export interface BoundWithClause extends AstNode {
    readonly kind: "BoundWithClause";
    readonly ast: WithClauseNode;
    readonly ctes: readonly BoundCommonTableExpression[];
}

export interface BoundCommonTableExpression extends AstNode {
    readonly kind: "BoundCommonTableExpression";
    readonly ast: CommonTableExpressionNode;
    readonly name: string;
    readonly query: BoundQuery;
    readonly table: TableSchema;
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
    readonly output: readonly BoundOutputColumn[];
}

export interface BoundOutputColumn {
    readonly name: string;
    readonly column: ColumnSchema;
    readonly sourceTable?: BoundTableReference;
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
    readonly columns: readonly BoundOutputColumn[];
}

export interface BoundTableReference extends AstNode {
    readonly kind: "BoundTableReference";
    readonly ast: TableReferenceNode;
    readonly table: TableSchema;
    readonly alias: string;
    readonly source: "catalog" | "derived" | "cte";
    readonly subquery?: BoundQuery;
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
    readonly ctes: ReadonlyMap<string, BoundCommonTableExpression>;
}

export type BoundExpression =
    | BoundLiteral
    | BoundParameter
    | BoundUnaryExpression
    | BoundBinaryExpression
    | BoundFunctionCall
    | BoundCastExpression
    | BoundCaseExpression
    | BoundIntervalExpression
    | BoundColumnReference
    | BoundGroupingExpression
    | BoundWildcardExpression
    | BoundIsNullExpression
    | BoundCurrentKeywordExpression
    | BoundInListExpression
    | BoundInSubqueryExpression
    | BoundExistsExpression
    | BoundScalarSubqueryExpression;

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

export interface BoundCastExpression extends AstNode {
    readonly kind: "BoundCastExpression";
    readonly ast: CastExpressionNode;
    readonly expression: BoundExpression;
    readonly targetType: CastTypeNode;
}

export interface BoundCaseWhenClause extends AstNode {
    readonly kind: "BoundCaseWhenClause";
    readonly ast: CaseWhenClauseNode;
    readonly when: BoundExpression;
    readonly then: BoundExpression;
}

export interface BoundCaseExpression extends AstNode {
    readonly kind: "BoundCaseExpression";
    readonly ast: CaseExpressionNode;
    readonly operand?: BoundExpression;
    readonly whenClauses: readonly BoundCaseWhenClause[];
    readonly elseExpression?: BoundExpression;
}

export interface BoundIntervalExpression extends AstNode {
    readonly kind: "BoundIntervalExpression";
    readonly ast: IntervalExpressionNode;
    readonly value: BoundExpression;
    readonly unit: IntervalExpressionNode["unit"];
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

export interface BoundInSubqueryExpression extends AstNode {
    readonly kind: "BoundInSubqueryExpression";
    readonly ast: InSubqueryExpressionNode;
    readonly operand: BoundExpression;
    readonly query: BoundQuery;
    readonly negated: boolean;
}

export interface BoundExistsExpression extends AstNode {
    readonly kind: "BoundExistsExpression";
    readonly ast: ExistsExpressionNode;
    readonly query: BoundQuery;
    readonly negated: boolean;
}

export interface BoundScalarSubqueryExpression extends AstNode {
    readonly kind: "BoundScalarSubqueryExpression";
    readonly ast: ScalarSubqueryExpressionNode;
    readonly query: BoundQuery;
}
