import { formatDiagnostics } from "../../src/core/diagnostics";
import { parse } from "../../src/parser";

export function parseQuery(sql: string) {
    const parsed = parse(sql);
    if (!parsed.ok) {
        throw new Error(
            `Parse failed:\n${formatDiagnostics({ source: sql, diagnostics: parsed.diagnostics })}`,
        );
    }

    return parsed.value;
}
