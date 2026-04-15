import { createSourceFile, getLocation, type SourceFile, type SourceSpan } from "./source";

export enum CompilerStage {
    Lexer = "lexer",
    Parser = "parser",
    Rewriter = "rewriter",
    Binder = "binder",
    Enforcer = "enforcer",
    Emitter = "emitter",
    Compiler = "compiler",
}

export enum DiagnosticSeverity {
    Error = "error",
}

export enum DiagnosticVisibility {
    Public = "public",
    PublicRedacted = "public-redacted",
    Internal = "internal",
}

export enum DiagnosticCode {
    UnexpectedCharacter = "unexpected-character",
    UnterminatedString = "unterminated-string",
    UnterminatedQuotedIdentifier = "unterminated-quoted-identifier",
    InvalidIdentifier = "invalid-identifier",
    UnsupportedComment = "unsupported-comment",
    UnexpectedToken = "unexpected-token",
    UnexpectedEndOfInput = "unexpected-end-of-input",
    UnsupportedStatement = "unsupported-statement",
    UnsupportedConstruct = "unsupported-construct",
    UnknownTable = "unknown-table",
    UnknownColumn = "unknown-column",
    NonSelectableColumn = "non-selectable-column",
    AmbiguousColumn = "ambiguous-column",
    DuplicateAlias = "duplicate-alias",
    InvalidColumnArity = "invalid-column-arity",
    InvalidWildcardQualifier = "invalid-wildcard-qualifier",
    DisallowedFunction = "disallowed-function",
    UnsupportedOperator = "unsupported-operator",
    LimitExceeded = "limit-exceeded",
    PolicyViolation = "policy-violation",
    PolicyExecutionError = "policy-execution-error",
    InvalidPolicyConfiguration = "invalid-policy-configuration",
    RewriteInvariantViolation = "rewrite-invariant-violation",
    EmitInvariantViolation = "emit-invariant-violation",
    InternalCompilerError = "internal-compiler-error",
}

export interface DiagnosticNote {
    readonly message: string;
    readonly span?: SourceSpan;
}

export interface Diagnostic {
    readonly code: DiagnosticCode;
    readonly stage: CompilerStage;
    readonly severity: DiagnosticSeverity;
    readonly visibility: DiagnosticVisibility;
    readonly message: string;
    readonly primarySpan: SourceSpan;
    readonly relatedSpans?: readonly DiagnosticNote[];
    readonly help?: string;
    readonly publicMessage?: string;
    readonly publicHelp?: string;
    readonly publicCode?: DiagnosticCode;
}

export interface DiagnosticsCarrier {
    readonly source: string;
    readonly diagnostics: readonly Diagnostic[];
}

export function createDiagnostic(input: {
    code: DiagnosticCode;
    stage: CompilerStage;
    message: string;
    primarySpan: SourceSpan;
    relatedSpans?: readonly DiagnosticNote[];
    help?: string;
    visibility?: DiagnosticVisibility;
    publicMessage?: string;
    publicHelp?: string;
    publicCode?: DiagnosticCode;
}): Diagnostic {
    return {
        severity: DiagnosticSeverity.Error,
        visibility: DiagnosticVisibility.Public,
        ...input,
    };
}

export function projectDiagnosticForPublic(diagnostic: Diagnostic): Diagnostic | undefined {
    if (diagnostic.visibility === DiagnosticVisibility.Internal) {
        return undefined;
    }

    return {
        ...diagnostic,
        stage: CompilerStage.Compiler,
        visibility: DiagnosticVisibility.Public,
        code:
            diagnostic.visibility === DiagnosticVisibility.PublicRedacted &&
            typeof diagnostic.publicCode !== "undefined"
                ? diagnostic.publicCode
                : diagnostic.code,
        message:
            diagnostic.visibility === DiagnosticVisibility.PublicRedacted &&
            typeof diagnostic.publicMessage === "string"
                ? diagnostic.publicMessage
                : diagnostic.message,
        help:
            diagnostic.visibility === DiagnosticVisibility.PublicRedacted
                ? diagnostic.publicHelp
                : diagnostic.help,
        relatedSpans:
            diagnostic.visibility === DiagnosticVisibility.PublicRedacted
                ? undefined
                : diagnostic.relatedSpans,
        publicCode: undefined,
        publicMessage: undefined,
        publicHelp: undefined,
    };
}

export function formatDiagnostics(input: DiagnosticsCarrier): string {
    if (input.diagnostics.length === 0) {
        return "";
    }

    const sourceFile = createSourceFile(input.source);
    return input.diagnostics
        .map((diagnostic) => formatOneDiagnostic(diagnostic, sourceFile))
        .join("\n\n");
}

function formatOneDiagnostic(diagnostic: Diagnostic, sourceFile: SourceFile): string {
    const start = getLocation(sourceFile.lineMap, diagnostic.primarySpan.start);
    const end = getLocation(sourceFile.lineMap, diagnostic.primarySpan.end);
    const nearExcerpt = createNearExcerpt(
        sourceFile.text,
        diagnostic.primarySpan.start,
        diagnostic.primarySpan.end,
    );
    const lines = [
        `${diagnostic.severity}[${diagnostic.stage}/${diagnostic.code}] ${diagnostic.message}`,
        `at ${start.line}:${start.column}-${end.line}:${end.column} near ${JSON.stringify(nearExcerpt)}`,
    ];

    if (diagnostic.help) {
        lines.push(`help: ${diagnostic.help}`);
    }

    return lines.join("\n");
}

function createNearExcerpt(text: string, startOffset: number, endOffset: number): string {
    const padding = 5;
    const safeEndOffset = Math.max(startOffset + 1, endOffset);
    const excerptStart = Math.max(0, startOffset - padding);
    const excerptEnd = Math.min(text.length, safeEndOffset + padding);
    const prefix = excerptStart > 0 ? "..." : "";
    const suffix = excerptEnd < text.length ? "..." : "";

    return `${prefix}${normalizeWhitespace(text.slice(excerptStart, excerptEnd))}${suffix}`;
}

function normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}
