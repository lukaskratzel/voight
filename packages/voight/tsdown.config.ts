import { defineConfig } from "tsdown";

export default defineConfig({
    clean: true,
    dts: true,
    entry: ["index.ts"],
    format: ["esm"],
    outDir: "dist",
    platform: "node",
    sourcemap: true,
    target: "node20",
});
