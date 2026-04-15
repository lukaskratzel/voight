import {
    CompilerStage,
    DiagnosticCode,
    DiagnosticVisibility,
    createDiagnostic,
} from "../core/diagnostics";
import type { ParseResult } from "./index";
import { validateQueryAst, type QueryAst } from "../ast/query-ast-schema";
import { stageFailure, stageSuccess } from "../core/result";
import { createSourceFile, createSpan, type SourceFile, type SourceSpan } from "../core/source";

type NativeObject = Record<string, unknown>;

interface NativeParserError {
    readonly error: true;
    readonly type?: string;
    readonly message?: string;
    readonly help?: string;
    readonly span?: NativeSpanLike;
    readonly start?: unknown;
    readonly end?: unknown;
}

type NativeSpanLike =
    | { readonly start: unknown; readonly end: unknown }
    | { readonly offset: unknown }
    | number;

export function parseNativeParserOutput(
    source: string | SourceFile,
    output: string,
): ParseResult<QueryAst> {
    const sourceFile = typeof source === "string" ? createSourceFile(source) : source;
    const fallbackSpan = createSpan(0, sourceFile.text.length);

    let parsed: unknown;
    try {
        parsed = JSON.parse(output);
    } catch {
        return stageFailure(
            CompilerStage.Parser,
            [
                createDiagnostic({
                    code: DiagnosticCode.UnsupportedConstruct,
                    stage: CompilerStage.Parser,
                    message: "Native parser returned invalid JSON.",
                    primarySpan: fallbackSpan,
                    visibility: DiagnosticVisibility.Internal,
                }),
            ],
            { tokenIndex: 0 },
        );
    }

    if (isNativeParserError(parsed)) {
        return stageFailure(
            CompilerStage.Parser,
            [
                createDiagnostic({
                    code: mapNativeErrorCode(parsed, fallbackSpan, sourceFile.text.length),
                    stage: CompilerStage.Parser,
                    message: parsed.message ?? "Native parser reported an unknown error.",
                    primarySpan: readDiagnosticSpan(parsed, fallbackSpan),
                    help: typeof parsed.help === "string" ? parsed.help : undefined,
                }),
            ],
            { tokenIndex: 0 },
        );
    }

    const validatedAst = validateQueryAst(parsed);
    if (!validatedAst.ok) {
        return stageFailure(
            CompilerStage.Parser,
            [
                createDiagnostic({
                    code: DiagnosticCode.UnsupportedConstruct,
                    stage: CompilerStage.Parser,
                    message: `Native parser returned an unsupported AST shape: ${validatedAst.summary}`,
                    primarySpan: fallbackSpan,
                    visibility: DiagnosticVisibility.Internal,
                }),
            ],
            { tokenIndex: 0 },
        );
    }

    return stageSuccess(CompilerStage.Parser, validatedAst.value, { tokenIndex: 0 });
}

function isNativeParserError(value: unknown): value is NativeParserError {
    return isObject(value) && value.error === true;
}

function mapNativeErrorCode(
    error: NativeParserError,
    fallbackSpan: SourceSpan,
    sourceLength: number,
): DiagnosticCode {
    const message = error.message?.toLowerCase();

    if (error.type === "InvalidIdentifier") {
        return DiagnosticCode.InvalidIdentifier;
    }

    if (error.type === "UnsupportedConstruct") {
        if (message?.includes("comment")) {
            return DiagnosticCode.UnsupportedComment;
        }
        return DiagnosticCode.UnsupportedConstruct;
    }

    if (error.type === "NotImplementedError") {
        return DiagnosticCode.UnsupportedConstruct;
    }

    const span = readDiagnosticSpan(error, fallbackSpan);
    if (
        error.type === "SyntaxError" &&
        span.start === 0 &&
        message?.includes("select") &&
        message.includes("with")
    ) {
        return DiagnosticCode.UnsupportedStatement;
    }

    const referencesEndOfInput = message?.includes("end of input") ?? false;
    const sawEofToken = message?.includes("<eof>") ?? false;
    const pointsAtEndOfSource = span.start >= sourceLength || span.end >= sourceLength;

    if (referencesEndOfInput || (sawEofToken && pointsAtEndOfSource)) {
        return DiagnosticCode.UnexpectedEndOfInput;
    }

    return DiagnosticCode.UnexpectedToken;
}

function readDiagnosticSpan(error: NativeParserError, fallbackSpan: SourceSpan): SourceSpan {
    if (typeof error.span !== "undefined") {
        return readSpanValue(error.span, fallbackSpan);
    }

    if (typeof error.start !== "undefined" || typeof error.end !== "undefined") {
        return createSpan(
            readOffset(error.start, fallbackSpan.start),
            readOffset(error.end, fallbackSpan.end),
        );
    }

    return fallbackSpan;
}

function readSpanValue(value: unknown, fallbackSpan: SourceSpan): SourceSpan {
    if (typeof value === "number" && Number.isFinite(value)) {
        return createSpan(value, value);
    }

    if (!isObject(value)) {
        return fallbackSpan;
    }

    return createSpan(
        readOffset(value.start, fallbackSpan.start),
        readOffset(value.end, fallbackSpan.end),
    );
}

function readOffset(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (isObject(value) && typeof value.offset === "number" && Number.isFinite(value.offset)) {
        return value.offset;
    }

    return fallback;
}

function isObject(value: unknown): value is NativeObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
