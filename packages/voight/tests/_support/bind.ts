import { formatDiagnostics } from "../../src/core/diagnostics";
import { bind } from "../../src/binder";
import { createTestCatalog } from "../../src/testing";
import { parseQuery } from "./parse";

export function bindStatement(sql: string) {
    const bound = bind(parseQuery(sql), createTestCatalog());
    if (!bound.ok) {
        throw new Error(formatDiagnostics({ source: sql, diagnostics: bound.diagnostics }));
    }

    return bound.value;
}
