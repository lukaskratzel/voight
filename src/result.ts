import type { Diagnostic } from "./diagnostics";

export interface StageSuccess<T, TStage extends string, TMeta = undefined> {
    readonly ok: true;
    readonly stage: TStage;
    readonly diagnostics: readonly [];
    readonly value: T;
    readonly meta: TMeta;
}

export interface StageFailure<TStage extends string, TMeta = undefined> {
    readonly ok: false;
    readonly stage: TStage;
    readonly diagnostics: readonly Diagnostic[];
    readonly meta: TMeta;
}

export type StageResult<T, TStage extends string, TMeta = undefined> =
    | StageSuccess<T, TStage, TMeta>
    | StageFailure<TStage, TMeta>;

export function stageSuccess<T, TStage extends string, TMeta>(
    stage: TStage,
    value: T,
    meta: TMeta,
): StageSuccess<T, TStage, TMeta> {
    return {
        ok: true,
        stage,
        diagnostics: [],
        value,
        meta,
    };
}

export function stageFailure<TStage extends string, TMeta>(
    stage: TStage,
    diagnostics: readonly Diagnostic[],
    meta: TMeta,
): StageFailure<TStage, TMeta> {
    return {
        ok: false,
        stage,
        diagnostics,
        meta,
    };
}
