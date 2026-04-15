import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface VoightParserModule {
    parseQuery(input: string): string;
}

interface WasmParserExports {
    parseQuery?: unknown;
}

interface WasmParserBundle {
    default?: unknown;
}

const packageWasmModuleUrl = new URL("./voight_parser_wasm.js", import.meta.url);

export interface VoightParserLoaderOptions {
    readonly moduleUrl?: URL;
    readonly moduleExists?: (path: string) => boolean;
    readonly importModule?: (href: string) => Promise<WasmParserBundle>;
}

export async function createVoightParser(
    options: VoightParserLoaderOptions = {},
): Promise<VoightParserModule> {
    const moduleExists = options.moduleExists ?? existsSync;
    const moduleUrl = options.moduleUrl ?? packageWasmModuleUrl;
    const importModule =
        options.importModule ?? (async (href: string) => (await import(href)) as WasmParserBundle);
    const wasmModulePath = fileURLToPath(moduleUrl);

    if (!moduleExists(wasmModulePath)) {
        throw new Error(
            "Voight parser bundle is missing. Run `pnpm parser:build` for local development or `pnpm --filter @voight8/voight build` to prepare the publishable package.",
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
