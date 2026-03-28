import type { BoundSelectStatement, SelectStatementAst } from "./ast";
import type { Catalog } from "./catalog";
import { CompilerStage, type Diagnostic } from "./diagnostics";
import { bind, type BindResult } from "./binder";
import { emit, type EmitResult, type EmitValue } from "./emitter";
import type { TokenStream } from "./lexer";
import { tokenize, type LexResult } from "./lexer";
import { parse, type ParseResult } from "./parser";
import { createSourceFile } from "./source";
import { validate, type ValidationOptions, type ValidationResult } from "./validator";

export interface CompileOptions extends ValidationOptions {
    readonly catalog: Catalog;
    readonly dialect: "mysql";
    readonly strict?: true;
}

export interface CompileResult {
    readonly ok: boolean;
    readonly source: string;
    readonly terminalStage: CompilerStage;
    readonly diagnostics: readonly Diagnostic[];
    readonly tokens?: TokenStream;
    readonly ast?: SelectStatementAst;
    readonly bound?: BoundSelectStatement;
    readonly emitted?: EmitValue;
    readonly stages: {
        readonly lex: LexResult;
        readonly parse?: ParseResult<SelectStatementAst>;
        readonly bind?: BindResult<BoundSelectStatement>;
        readonly validate?: ValidationResult;
        readonly emit?: EmitResult;
    };
}

export function compile(source: string, options: CompileOptions): CompileResult {
    const sourceFile = createSourceFile(source);
    const lex = tokenize(sourceFile);
    if (!lex.ok) {
        return {
            ok: false,
            source,
            terminalStage: CompilerStage.Lexer,
            diagnostics: lex.diagnostics,
            stages: { lex },
        };
    }

    const parsed = parse(lex.value);
    if (!parsed.ok) {
        return {
            ok: false,
            source,
            terminalStage: CompilerStage.Parser,
            diagnostics: parsed.diagnostics,
            tokens: lex.value,
            stages: { lex, parse: parsed },
        };
    }

    const bound = bind(parsed.value, options.catalog);
    if (!bound.ok) {
        return {
            ok: false,
            source,
            terminalStage: CompilerStage.Binder,
            diagnostics: bound.diagnostics,
            tokens: lex.value,
            ast: parsed.value,
            stages: { lex, parse: parsed, bind: bound },
        };
    }

    const validated = validate(bound.value, {
        allowedFunctions: options.allowedFunctions,
        maxLimit: options.maxLimit,
    });
    if (!validated.ok) {
        return {
            ok: false,
            source,
            terminalStage: CompilerStage.Validator,
            diagnostics: validated.diagnostics,
            tokens: lex.value,
            ast: parsed.value,
            bound: bound.value,
            stages: { lex, parse: parsed, bind: bound, validate: validated },
        };
    }

    const emitted = emit(bound.value);
    if (!emitted.ok) {
        return {
            ok: false,
            source,
            terminalStage: CompilerStage.Emitter,
            diagnostics: emitted.diagnostics,
            tokens: lex.value,
            ast: parsed.value,
            bound: bound.value,
            stages: { lex, parse: parsed, bind: bound, validate: validated, emit: emitted },
        };
    }

    return {
        ok: true,
        source,
        terminalStage: CompilerStage.Emitter,
        diagnostics: [],
        tokens: lex.value,
        ast: parsed.value,
        bound: bound.value,
        emitted: emitted.value,
        stages: { lex, parse: parsed, bind: bound, validate: validated, emit: emitted },
    };
}
