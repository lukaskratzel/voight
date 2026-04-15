import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

import { createVoightParser } from "../../../src/parser/wasm-loader";

const packageWasmModulePath = fileURLToPath(
    new URL("../../../src/parser/voight_parser_wasm.js", import.meta.url),
);

describe("wasm loader", () => {
    test("loads the package-local parser bundle by default", async () => {
        let importedHref: string | undefined;

        const parser = await createVoightParser({
            moduleExists(path) {
                return path === packageWasmModulePath;
            },
            async importModule(href) {
                importedHref = href;
                return {
                    default: async () => ({
                        parseQuery(input: string) {
                            return input;
                        },
                    }),
                };
            },
        });

        expect(importedHref).toBe(pathToFileURL(packageWasmModulePath).href);
        expect(parser.parseQuery("SELECT 1")).toBe("SELECT 1");
    });

    test("respects an explicit module URL override", async () => {
        let importedHref: string | undefined;
        const moduleUrl = pathToFileURL(packageWasmModulePath);

        await createVoightParser({
            moduleUrl,
            moduleExists(path) {
                return path === packageWasmModulePath;
            },
            async importModule(href) {
                importedHref = href;
                return {
                    default: async () => ({
                        parseQuery(input: string) {
                            return input;
                        },
                    }),
                };
            },
        });

        expect(importedHref).toBe(moduleUrl.href);
    });
});
