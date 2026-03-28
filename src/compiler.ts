import type { BoundQuery, QueryAst } from "./ast";
import { analyze, type AnalysisResult } from "./analyzer";
import type { Catalog } from "./catalog";
import { CompilerStage, type Diagnostic } from "./diagnostics";
import { bind, type BindResult } from "./binder";
import { emit, type EmitResult, type EmitValue } from "./emitter";
import { enforce, type EnforcementOptions, type EnforcementResult } from "./enforcer";
import type { TokenStream } from "./lexer";
import { tokenize, type LexResult } from "./lexer";
import { parse, type ParseResult } from "./parser";
import type { CompilerPolicy, PolicyContext } from "./policies";
import { rewrite, type RewriteOptions, type RewriteResult } from "./rewriter";
import { createSourceFile } from "./source";

export interface CompileOptions extends RewriteOptions, EnforcementOptions {
    readonly catalog: Catalog;
    readonly dialect: "mysql";
    readonly policies?: readonly CompilerPolicy[];
    readonly policyContext?: PolicyContext;
    readonly strict?: true;
}

export interface CompileResult {
    readonly ok: boolean;
    readonly source: string;
    readonly terminalStage: CompilerStage;
    readonly diagnostics: readonly Diagnostic[];
    readonly tokens?: TokenStream;
    readonly ast?: QueryAst;
    readonly rewrittenAst?: QueryAst;
    readonly bound?: BoundQuery;
    readonly emitted?: EmitValue;
    readonly stages: {
        readonly lex: LexResult;
        readonly parse?: ParseResult<QueryAst>;
        readonly rewrite?: RewriteResult;
        readonly bind?: BindResult<BoundQuery>;
        readonly analyze?: AnalysisResult;
        readonly enforce?: EnforcementResult;
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

    const rewritten = rewrite(parsed.value, {
        policies: options.policies,
        policyContext: options.policyContext,
        rewriters: options.rewriters,
    });
    if (!rewritten.ok) {
        return {
            ok: false,
            source,
            terminalStage: CompilerStage.Rewriter,
            diagnostics: rewritten.diagnostics,
            tokens: lex.value,
            ast: parsed.value,
            stages: { lex, parse: parsed, rewrite: rewritten },
        };
    }

    const bound = bind(rewritten.value, options.catalog);
    if (!bound.ok) {
        return {
            ok: false,
            source,
            terminalStage: CompilerStage.Binder,
            diagnostics: bound.diagnostics,
            tokens: lex.value,
            ast: parsed.value,
            rewrittenAst: rewritten.value,
            stages: { lex, parse: parsed, rewrite: rewritten, bind: bound },
        };
    }

    const analyzed = analyze(bound.value);
    if (!analyzed.ok) {
        return {
            ok: false,
            source,
            terminalStage: CompilerStage.Analyzer,
            diagnostics: analyzed.diagnostics,
            tokens: lex.value,
            ast: parsed.value,
            rewrittenAst: rewritten.value,
            bound: bound.value,
            stages: { lex, parse: parsed, rewrite: rewritten, bind: bound, analyze: analyzed },
        };
    }

    const enforced = enforce(bound.value, analyzed.value, {
        allowedFunctions: options.allowedFunctions,
        maxLimit: options.maxLimit,
        policies: options.policies,
        policyContext: options.policyContext,
    });
    if (!enforced.ok) {
        return {
            ok: false,
            source,
            terminalStage: CompilerStage.Enforcer,
            diagnostics: enforced.diagnostics,
            tokens: lex.value,
            ast: parsed.value,
            rewrittenAst: rewritten.value,
            bound: bound.value,
            stages: {
                lex,
                parse: parsed,
                rewrite: rewritten,
                bind: bound,
                analyze: analyzed,
                enforce: enforced,
            },
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
            rewrittenAst: rewritten.value,
            bound: bound.value,
            stages: {
                lex,
                parse: parsed,
                rewrite: rewritten,
                bind: bound,
                analyze: analyzed,
                enforce: enforced,
                emit: emitted,
            },
        };
    }

    return {
        ok: true,
        source,
        terminalStage: CompilerStage.Emitter,
        diagnostics: [],
        tokens: lex.value,
        ast: parsed.value,
        rewrittenAst: rewritten.value,
        bound: bound.value,
        emitted: emitted.value,
        stages: {
            lex,
            parse: parsed,
            rewrite: rewritten,
            bind: bound,
            analyze: analyzed,
            enforce: enforced,
            emit: emitted,
        },
    };
}
