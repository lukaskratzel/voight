import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface VoightParserModule {
    parseQuery(input: string): string;
}

interface WasmParserExports {
    parseQuery?: unknown;
}

interface WasmParserModule {
    default?: unknown;
}

const wasmModuleUrl = new URL("./dist/voight_parser_wasm.js", import.meta.url);

export interface VoightParserLoaderOptions {
    readonly moduleUrl?: URL;
    readonly moduleExists?: (path: string) => boolean;
    readonly importModule?: (href: string) => Promise<WasmParserModule>;
}

export async function createVoightParser(
    options: VoightParserLoaderOptions = {},
): Promise<VoightParserModule> {
    const moduleUrl = options.moduleUrl ?? wasmModuleUrl;
    const moduleExists = options.moduleExists ?? existsSync;
    const importModule =
        options.importModule ?? (async (href: string) => (await import(href)) as WasmParserModule);
    const wasmModulePath = fileURLToPath(moduleUrl);

    if (!moduleExists(wasmModulePath)) {
        throw new Error(
            "Voight parser bundle is missing. Run `pnpm parser:build` to generate `packages/voight-parser/dist/voight_parser_wasm.js`.",
        );
    }

    const loadedModule = await importModule(moduleUrl.href);

    if (typeof loadedModule.default !== "function") {
        throw new Error("Voight parser bundle is missing its default module factory export.");
    }

    const wasmParser = (await loadedModule.default()) as WasmParserExports;

    if (typeof wasmParser.parseQuery !== "function") {
        throw new Error("Voight parser module is missing the parseQuery export.");
    }

    const parseQuery = wasmParser.parseQuery;

    return {
        parseQuery(input: string) {
            return parseQuery(input) as string;
        },
    };
}

export default createVoightParser;
