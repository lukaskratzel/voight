import { defineConfig } from "tsdown";

export default defineConfig({
    clean: true,
    dts: true,
    deps: {
        neverBundle: [/voight_parser_wasm\.js$/],
    },
    entry: ["index.ts"],
    format: ["esm"],
    outDir: "dist",
    platform: "node",
    sourcemap: true,
    target: "node20",
});
