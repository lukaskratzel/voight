export interface IdentifierPath {
    readonly parts: readonly string[];
}

export interface ColumnSchema {
    readonly id: string;
    readonly name: string;
    readonly type?: string;
}

export interface TableSchema {
    readonly id: string;
    readonly name: string;
    readonly path: IdentifierPath;
    readonly columns: ReadonlyMap<string, ColumnSchema>;
}

export interface Catalog {
    getTable(name: IdentifierPath): TableSchema | null;
    resolveColumn(table: TableSchema, columnName: string): ColumnSchema | null;
}

export class InMemoryCatalog implements Catalog {
    readonly #tables: Map<string, TableSchema>;

    constructor(tables: readonly TableSchema[]) {
        this.#tables = new Map(tables.map((table) => [normalizeIdentifierPath(table.path), table]));
    }

    getTable(name: IdentifierPath): TableSchema | null {
        return this.#tables.get(normalizeIdentifierPath(name)) ?? null;
    }

    resolveColumn(table: TableSchema, columnName: string): ColumnSchema | null {
        return table.columns.get(normalizeIdentifier(columnName)) ?? null;
    }
}

export function createIdentifierPath(...parts: string[]): IdentifierPath {
    return {
        parts: parts.map(normalizeIdentifier),
    };
}

export function createTableSchema(input: {
    id: string;
    path: readonly string[];
    columns: readonly string[];
}): TableSchema {
    return {
        id: input.id,
        name: normalizeIdentifier(input.path[input.path.length - 1] ?? input.id),
        path: createIdentifierPath(...input.path),
        columns: new Map(
            input.columns.map((column) => [
                normalizeIdentifier(column),
                {
                    id: `${input.id}.${normalizeIdentifier(column)}`,
                    name: normalizeIdentifier(column),
                },
            ]),
        ),
    };
}

export function normalizeIdentifier(value: string): string {
    return value.toLowerCase();
}

function normalizeIdentifierPath(path: IdentifierPath): string {
    return path.parts.map(normalizeIdentifier).join(".");
}
