parser grammar VoightParser;

options {
    tokenVocab = VoightLexer;
}

query
    : queryExpression SEMICOLON? EOF
    ;

queryExpression
    : withClause? selectStatement
    ;

withClause
    : WITH commonTableExpression (COMMA commonTableExpression)*
    ;

commonTableExpression
    : identifier columnList? AS LPAREN queryExpression RPAREN
    ;

columnList
    : LPAREN identifier (COMMA identifier)* RPAREN
    ;

selectStatement
    : SELECT DISTINCT? selectItem (COMMA selectItem)*
      fromClause?
      joinClause*
      whereClause?
      groupByClause?
      havingClause?
      orderByClause?
      limitClause?
    ;

selectItem
    : ASTERISK
    | identifier DOT ASTERISK
    | expression alias?
    ;

alias
    : AS? identifier
    ;

fromClause
    : FROM tableReference
    ;

tableReference
    : LPAREN queryExpression RPAREN alias
    | qualifiedName alias?
    ;

joinClause
    : ((INNER | LEFT)? JOIN) tableReference ON expression
    ;

whereClause
    : WHERE expression
    ;

groupByClause
    : GROUP BY expression (COMMA expression)*
    ;

havingClause
    : HAVING expression
    ;

orderByClause
    : ORDER BY orderByItem (COMMA orderByItem)*
    ;

orderByItem
    : expression (ASC | DESC)?
    ;

windowSpecification
    : OVER LPAREN partitionByClause? windowOrderByClause? RPAREN
    ;

partitionByClause
    : PARTITION BY expression (COMMA expression)*
    ;

windowOrderByClause
    : ORDER BY orderByItem (COMMA orderByItem)*
    ;

limitClause
    : LIMIT expression ((COMMA expression) | (OFFSET expression))?
    ;

expression
    : orExpression
    ;

orExpression
    : andExpression (OR andExpression)*
    ;

andExpression
    : comparisonExpression (AND comparisonExpression)*
    ;

comparisonExpression
    : additiveExpression (
        IS NOT? NULL_SQL
        | IN inPredicate
        | NOT IN inPredicate
        | comparisonOperator additiveExpression
      )?
    ;

inPredicate
    : LPAREN queryExpression RPAREN
    | LPAREN expression (COMMA expression)* RPAREN
    ;

comparisonOperator
    : EQ
    | NEQ
    | LT
    | LTE
    | GT
    | GTE
    | LIKE
    ;

additiveExpression
    : multiplicativeExpression ((PLUS | DASH) multiplicativeExpression)*
    ;

multiplicativeExpression
    : unaryExpression ((ASTERISK | SLASH | PERCENT) unaryExpression)*
    ;

unaryExpression
    : DASH unaryExpression
    | NOT EXISTS LPAREN queryExpression RPAREN
    | NOT unaryExpression
    | EXISTS LPAREN queryExpression RPAREN
    | primaryExpression
    ;

primaryExpression
    : CASE expression? caseWhenClause+ elseClause? END
    | CAST LPAREN expression AS castType RPAREN
    | INTERVAL expression intervalUnit
    | LPAREN queryExpression RPAREN
    | LPAREN expression RPAREN
    | literal
    | PARAMETER
    | CURRENT_TIMESTAMP
    | CURRENT_DATE
    | CURRENT_TIME
    | ASTERISK
    | identifier LPAREN (DISTINCT argumentList | argumentList)? RPAREN windowSpecification?
    | identifier DOT ASTERISK
    | identifier DOT identifier
    | identifier
    ;

caseWhenClause
    : WHEN expression THEN expression
    ;

elseClause
    : ELSE expression
    ;

castType
    : qualifiedName (LPAREN castTypeArgument (COMMA castTypeArgument)* RPAREN)?
    ;

castTypeArgument
    : INTEGER_LITERAL
    | castType
    ;

intervalUnit
    : SECOND
    | MINUTE
    | HOUR
    | DAY
    | WEEK
    | MONTH
    | QUARTER
    | YEAR
    ;

argumentList
    : expression (COMMA expression)*
    ;

literal
    : DECIMAL_LITERAL
    | INTEGER_LITERAL
    | STRING_LITERAL
    | TRUE_SQL
    | FALSE_SQL
    | NULL_SQL
    ;

qualifiedName
    : identifier (DOT identifier)*
    ;

identifier
    : IDENTIFIER
    ;
