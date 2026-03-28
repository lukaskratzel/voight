import { CompilerStage, DiagnosticCode, createDiagnostic, type Diagnostic } from "./diagnostics";
import { stageFailure, stageSuccess, type StageResult } from "./result";
import { createSourceFile, createSpan, type SourceFile, type SourceSpan } from "./source";

const KEYWORDS = new Set([
    "SELECT",
    "FROM",
    "WHERE",
    "GROUP",
    "BY",
    "HAVING",
    "ORDER",
    "LIMIT",
    "OFFSET",
    "AS",
    "INNER",
    "LEFT",
    "JOIN",
    "ON",
    "AND",
    "OR",
    "NOT",
    "IS",
    "NULL",
    "TRUE",
    "FALSE",
    "ASC",
    "DESC",
    "WITH",
    "UPDATE",
    "INSERT",
    "DELETE",
    "SET",
    "UNION",
    "IN",
    "CURRENT_TIMESTAMP",
    "CURRENT_DATE",
    "CURRENT_TIME",
]);

export type TokenKind =
    | "keyword"
    | "identifier"
    | "string"
    | "number"
    | "parameter"
    | "comma"
    | "dot"
    | "left_paren"
    | "right_paren"
    | "operator"
    | "asterisk"
    | "semicolon"
    | "eof";

export interface Token {
    readonly kind: TokenKind;
    readonly text: string;
    readonly span: SourceSpan;
    readonly keyword?: string;
    readonly quoted?: boolean;
}

export interface TokenStream {
    readonly source: SourceFile;
    readonly tokens: readonly Token[];
}

export type LexResult = StageResult<TokenStream, CompilerStage.Lexer, { tokenCount: number }>;

export function tokenize(source: string | SourceFile): LexResult {
    const sourceFile = typeof source === "string" ? createSourceFile(source) : source;
    const diagnostics: Diagnostic[] = [];
    const tokens: Token[] = [];
    const text = sourceFile.text;
    let index = 0;

    function emitFailure(diagnostic: Diagnostic): LexResult {
        return stageFailure(CompilerStage.Lexer, [...diagnostics, diagnostic], {
            tokenCount: tokens.length,
        });
    }

    while (index < text.length) {
        const char = text[index] ?? "";

        if (isWhitespace(char)) {
            index += 1;
            continue;
        }

        const nextChar = text[index + 1] ?? "";
        const spanStart = index;

        if (char === "-" && nextChar === "-") {
            return emitFailure(
                createDiagnostic({
                    code: DiagnosticCode.UnsupportedComment,
                    stage: CompilerStage.Lexer,
                    message: "Comments are rejected in strict mode.",
                    primarySpan: createSpan(index, index + 2),
                    help: "Remove SQL comments before compiling.",
                }),
            );
        }

        if (char === "#" || (char === "/" && nextChar === "*")) {
            return emitFailure(
                createDiagnostic({
                    code: DiagnosticCode.UnsupportedComment,
                    stage: CompilerStage.Lexer,
                    message: "Comments are rejected in strict mode.",
                    primarySpan: createSpan(index, index + (char === "#" ? 1 : 2)),
                    help: "Remove SQL comments before compiling.",
                }),
            );
        }

        if (char === "'") {
            index += 1;
            let value = "'";
            let terminated = false;

            while (index < text.length) {
                const current = text[index] ?? "";
                value += current;
                index += 1;

                if (current === "'") {
                    if (text[index] === "'") {
                        value += "'";
                        index += 1;
                        continue;
                    }

                    terminated = true;
                    break;
                }
            }

            if (!terminated) {
                return emitFailure(
                    createDiagnostic({
                        code: DiagnosticCode.UnterminatedString,
                        stage: CompilerStage.Lexer,
                        message: "Unterminated string literal.",
                        primarySpan: createSpan(spanStart, text.length),
                    }),
                );
            }

            tokens.push({
                kind: "string",
                text: value,
                span: createSpan(spanStart, index),
            });
            continue;
        }

        if (char === "`") {
            index += 1;
            let value = "";
            let terminated = false;

            while (index < text.length) {
                const current = text[index] ?? "";
                if (current === "`") {
                    if (text[index + 1] === "`") {
                        value += "`";
                        index += 2;
                        continue;
                    }

                    index += 1;
                    terminated = true;
                    break;
                }

                value += current;
                index += 1;
            }

            if (!terminated) {
                return emitFailure(
                    createDiagnostic({
                        code: DiagnosticCode.UnterminatedQuotedIdentifier,
                        stage: CompilerStage.Lexer,
                        message: "Unterminated quoted identifier.",
                        primarySpan: createSpan(spanStart, text.length),
                    }),
                );
            }

            tokens.push({
                kind: "identifier",
                text: value,
                quoted: true,
                span: createSpan(spanStart, index),
            });
            continue;
        }

        if (isDigit(char)) {
            index += 1;
            let sawDot = false;

            while (index < text.length) {
                const current = text[index] ?? "";
                if (current === "." && !sawDot && isDigit(text[index + 1] ?? "")) {
                    sawDot = true;
                    index += 1;
                    continue;
                }

                if (!isDigit(current)) {
                    break;
                }

                index += 1;
            }

            tokens.push({
                kind: "number",
                text: text.slice(spanStart, index),
                span: createSpan(spanStart, index),
            });
            continue;
        }

        if (isIdentifierStart(char)) {
            index += 1;
            while (index < text.length && isIdentifierPart(text[index] ?? "")) {
                index += 1;
            }

            const value = text.slice(spanStart, index);
            const upper = value.toUpperCase();
            if (KEYWORDS.has(upper)) {
                tokens.push({
                    kind: "keyword",
                    text: upper,
                    keyword: upper,
                    span: createSpan(spanStart, index),
                });
            } else {
                tokens.push({
                    kind: "identifier",
                    text: value,
                    quoted: false,
                    span: createSpan(spanStart, index),
                });
            }
            continue;
        }

        if (char === "?") {
            index += 1;
            tokens.push({
                kind: "parameter",
                text: "?",
                span: createSpan(spanStart, index),
            });
            continue;
        }

        const simpleToken = SIMPLE_TOKENS[char];
        if (simpleToken) {
            index += 1;
            tokens.push({
                kind: simpleToken,
                text: char,
                span: createSpan(spanStart, index),
            });
            continue;
        }

        const operator = readOperator(text, index);
        if (operator) {
            index += operator.length;
            tokens.push({
                kind: "operator",
                text: operator,
                span: createSpan(spanStart, index),
            });
            continue;
        }

        return emitFailure(
            createDiagnostic({
                code: DiagnosticCode.UnexpectedCharacter,
                stage: CompilerStage.Lexer,
                message: `Unexpected character "${char}".`,
                primarySpan: createSpan(index, index + 1),
            }),
        );
    }

    tokens.push({
        kind: "eof",
        text: "",
        span: createSpan(text.length, text.length),
    });

    return stageSuccess(
        CompilerStage.Lexer,
        {
            source: sourceFile,
            tokens,
        },
        { tokenCount: tokens.length },
    );
}

const SIMPLE_TOKENS: Record<string, TokenKind | undefined> = {
    ",": "comma",
    ".": "dot",
    "(": "left_paren",
    ")": "right_paren",
    "*": "asterisk",
    ";": "semicolon",
};

function isWhitespace(char: string): boolean {
    return /\s/.test(char);
}

function isDigit(char: string): boolean {
    return /[0-9]/.test(char);
}

function isIdentifierStart(char: string): boolean {
    return /[A-Za-z_]/.test(char);
}

function isIdentifierPart(char: string): boolean {
    return /[A-Za-z0-9_$]/.test(char);
}

function readOperator(text: string, index: number): string | null {
    const twoCharacter = text.slice(index, index + 2);
    if (["<=", ">=", "!=", "<>"].includes(twoCharacter)) {
        return twoCharacter;
    }

    const oneCharacter = text[index] ?? "";
    if (["=", "<", ">", "+", "-", "/", "%"].includes(oneCharacter)) {
        return oneCharacter;
    }

    return null;
}
