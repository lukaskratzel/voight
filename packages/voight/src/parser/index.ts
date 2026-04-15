import { createVoightParser, type VoightParserModule as NativeParserModule } from "./wasm-loader";
import type { QueryAst } from "../ast";
import {
    CompilerStage,
    DiagnosticCode,
    DiagnosticVisibility,
    createDiagnostic,
} from "../core/diagnostics";
import { parseNativeParserOutput } from "./native-adapter";
import { stageFailure, type StageResult } from "../core/result";
import { createSourceFile, createSpan, type SourceFile } from "../core/source";

export type ParseResult<T> = StageResult<T, CompilerStage.Parser, { tokenIndex: number }>;

const nativeParserState = await initializeNativeParser();

export function parse(source: string | SourceFile): ParseResult<QueryAst> {
    const sourceFile = typeof source === "string" ? createSourceFile(source) : source;
    const preflight = runPreflightChecks(sourceFile);

    if (preflight) {
        return stageFailure(CompilerStage.Parser, [preflight], { tokenIndex: 0 });
    }

    if (!nativeParserState.module) {
        return stageFailure(
            CompilerStage.Parser,
            [
                createDiagnostic({
                    code: DiagnosticCode.UnsupportedConstruct,
                    stage: CompilerStage.Parser,
                    message:
                        nativeParserState.error instanceof Error
                            ? nativeParserState.error.message
                            : "Native parser failed to initialize.",
                    primarySpan: createSpan(0, sourceFile.text.length),
                    visibility: DiagnosticVisibility.Internal,
                }),
            ],
            { tokenIndex: 0 },
        );
    }

    try {
        return parseNativeParserOutput(
            sourceFile,
            nativeParserState.module.parseQuery(sourceFile.text),
        );
    } catch (error) {
        const fallbackDiagnostic = createDiagnostic({
            code: DiagnosticCode.UnsupportedConstruct,
            stage: CompilerStage.Parser,
            message: error instanceof Error ? error.message : "Native parser failed unexpectedly.",
            primarySpan: createSpan(0, sourceFile.text.length),
            visibility: DiagnosticVisibility.Internal,
        });
        return stageFailure(CompilerStage.Parser, [fallbackDiagnostic], { tokenIndex: 0 });
    }
}

async function initializeNativeParser(): Promise<{
    readonly module?: NativeParserModule;
    readonly error?: unknown;
}> {
    try {
        return {
            module: await createVoightParser(),
        };
    } catch (error) {
        return {
            error,
        };
    }
}

function runPreflightChecks(sourceFile: SourceFile) {
    const nullByteOffset = sourceFile.text.indexOf("\0");
    if (nullByteOffset !== -1) {
        return createDiagnostic({
            code: DiagnosticCode.UnexpectedCharacter,
            stage: CompilerStage.Parser,
            message: "Null bytes are not supported in query text.",
            primarySpan: createSpan(nullByteOffset, nullByteOffset + 1),
        });
    }

    return undefined;
}
