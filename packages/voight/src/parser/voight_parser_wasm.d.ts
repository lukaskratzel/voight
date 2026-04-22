export interface VoightParserWasmModule {
    parseQuery?: unknown;
}

export default function createVoightParser(
    moduleArg?: Record<string, unknown>,
): Promise<VoightParserWasmModule> | VoightParserWasmModule;
