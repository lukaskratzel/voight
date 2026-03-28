import { getLocation, type SourceFile, type SourceSpan } from "./source";

export enum CompilerStage {
    Lexer = "lexer",
    Parser = "parser",
    Rewriter = "rewriter",
    Binder = "binder",
    Analyzer = "analyzer",
    Enforcer = "enforcer",
    Validator = "validator",
    Emitter = "emitter",
    Compiler = "compiler",
}

export enum DiagnosticSeverity {
    Error = "error",
}

export enum DiagnosticCode {
    UnexpectedCharacter = "unexpected-character",
    UnterminatedString = "unterminated-string",
    UnterminatedQuotedIdentifier = "unterminated-quoted-identifier",
    UnsupportedComment = "unsupported-comment",
    UnexpectedToken = "unexpected-token",
    UnexpectedEndOfInput = "unexpected-end-of-input",
    UnsupportedStatement = "unsupported-statement",
    UnsupportedConstruct = "unsupported-construct",
    UnknownTable = "unknown-table",
    UnknownColumn = "unknown-column",
    AmbiguousColumn = "ambiguous-column",
    DuplicateAlias = "duplicate-alias",
    InvalidWildcardQualifier = "invalid-wildcard-qualifier",
    DisallowedFunction = "disallowed-function",
    UnsupportedOperator = "unsupported-operator",
    LimitExceeded = "limit-exceeded",
    PolicyViolation = "policy-violation",
    RewriteInvariantViolation = "rewrite-invariant-violation",
    EmitInvariantViolation = "emit-invariant-violation",
}

export interface DiagnosticNote {
    readonly message: string;
    readonly span?: SourceSpan;
}

export interface Diagnostic {
    readonly code: DiagnosticCode;
    readonly stage: CompilerStage;
    readonly severity: DiagnosticSeverity;
    readonly message: string;
    readonly primarySpan: SourceSpan;
    readonly relatedSpans?: readonly DiagnosticNote[];
    readonly help?: string;
}

export function createDiagnostic(input: {
    code: DiagnosticCode;
    stage: CompilerStage;
    message: string;
    primarySpan: SourceSpan;
    relatedSpans?: readonly DiagnosticNote[];
    help?: string;
}): Diagnostic {
    return {
        severity: DiagnosticSeverity.Error,
        ...input,
    };
}

export function formatDiagnostic(diagnostic: Diagnostic, sourceFile: SourceFile): string {
    const start = getLocation(sourceFile.lineMap, diagnostic.primarySpan.start);
    const end = getLocation(sourceFile.lineMap, diagnostic.primarySpan.end);
    const header = `${diagnostic.severity}[${diagnostic.stage}/${diagnostic.code}] ${diagnostic.message}`;
    const location = `at ${start.line}:${start.column}-${end.line}:${end.column}`;
    const help = diagnostic.help ? `\nhelp: ${diagnostic.help}` : "";

    return `${header}\n${location}${help}`;
}
