lexer grammar VoightLexer;

SELECT: S E L E C T;
FROM: F R O M;
WHERE: W H E R E;
GROUP: G R O U P;
BY: B Y;
HAVING: H A V I N G;
ORDER: O R D E R;
LIMIT: L I M I T;
OFFSET: O F F S E T;
AS: A S;
INNER: I N N E R;
LEFT: L E F T;
JOIN: J O I N;
ON: O N;
AND: A N D;
OR: O R;
NOT: N O T;
LIKE: L I K E;
IS: I S;
NULL_SQL: N U L L;
TRUE_SQL: T R U E;
FALSE_SQL: F A L S E;
ASC: A S C;
DESC: D E S C;
WITH: W I T H;
IN: I N;
EXISTS: E X I S T S;
CASE: C A S E;
CAST: C A S T;
INTERVAL: I N T E R V A L;
WHEN: W H E N;
THEN: T H E N;
ELSE: E L S E;
END: E N D;
SECOND: S E C O N D;
MINUTE: M I N U T E;
HOUR: H O U R;
DAY: D A Y;
WEEK: W E E K;
MONTH: M O N T H;
QUARTER: Q U A R T E R;
YEAR: Y E A R;
CURRENT_TIMESTAMP: C U R R E N T '_'? T I M E S T A M P;
CURRENT_DATE: C U R R E N T '_'? D A T E;
CURRENT_TIME: C U R R E N T '_'? T I M E;

IDENTIFIER
    : (LETTER | UNDERSCORE) (LETTER | UNDERSCORE | DEC_DIGIT | DOLLAR)*
    | BACKQUOTE ( BACKQUOTE BACKQUOTE | ~'`' )* BACKQUOTE
    ;

DECIMAL_LITERAL: DEC_DIGIT+ DOT DEC_DIGIT+;
INTEGER_LITERAL: DEC_DIGIT+;
STRING_LITERAL: QUOTE_SINGLE ( QUOTE_SINGLE QUOTE_SINGLE | ~'\'' )* QUOTE_SINGLE;

UNSUPPORTED_COMMENT
    : '--' ~[\r\n]*
    | '#' ~[\r\n]*
    | '/*' .*? '*/'
    ;

PARAMETER: '?';
COMMA: ',';
DOT: '.';
LPAREN: '(';
RPAREN: ')';
ASTERISK: '*';
SEMICOLON: ';';
NEQ: '!=' | '<>';
LTE: '<=';
GTE: '>=';
EQ: '=';
LT: '<';
GT: '>';
PLUS: '+';
DASH: '-';
SLASH: '/';
PERCENT: '%';
BACKQUOTE: '`';
DOLLAR: '$';
UNDERSCORE: '_';
QUOTE_SINGLE: '\'';

WHITESPACE: [ \t\r\n]+ -> skip;

fragment A: [aA];
fragment B: [bB];
fragment C: [cC];
fragment D: [dD];
fragment E: [eE];
fragment F: [fF];
fragment G: [gG];
fragment H: [hH];
fragment I: [iI];
fragment J: [jJ];
fragment K: [kK];
fragment L: [lL];
fragment M: [mM];
fragment N: [nN];
fragment O: [oO];
fragment P: [pP];
fragment Q: [qQ];
fragment R: [rR];
fragment S: [sS];
fragment T: [tT];
fragment U: [uU];
fragment V: [vV];
fragment W: [wW];
fragment X: [xX];
fragment Y: [yY];
fragment Z: [zZ];
fragment LETTER: [a-zA-Z];
fragment DEC_DIGIT: [0-9];
