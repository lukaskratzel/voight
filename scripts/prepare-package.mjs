import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const parserBundlePath = resolve(rootDir, "packages/voight/src/parser/voight_parser_wasm.js");
const packageDistDir = resolve(rootDir, "packages/voight/dist");
const packageBundlePath = resolve(packageDistDir, "voight_parser_wasm.js");

if (!existsSync(parserBundlePath)) {
    throw new Error(
        `Missing parser bundle at ${parserBundlePath}. Run pnpm parser:build before preparing the npm package.`,
    );
}

mkdirSync(packageDistDir, { recursive: true });
copyFileSync(parserBundlePath, packageBundlePath);
