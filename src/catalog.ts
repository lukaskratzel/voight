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

export interface CatalogTableAlias {
    readonly from: IdentifierPath;
    readonly to: IdentifierPath;
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

export class AliasCatalog implements Catalog {
    readonly #catalog: Catalog;
    readonly #aliases: Map<string, IdentifierPath>;

    constructor(catalog: Catalog, aliases: readonly CatalogTableAlias[]) {
        this.#catalog = catalog;
        this.#aliases = new Map(
            aliases.map((alias) => [
                normalizeIdentifierPath(alias.from),
                createIdentifierPath(...alias.to.parts),
            ]),
        );
    }

    getTable(name: IdentifierPath): TableSchema | null {
        const aliased = this.#aliases.get(normalizeIdentifierPath(name));
        return this.#catalog.getTable(aliased ?? name);
    }

    resolveColumn(table: TableSchema, columnName: string): ColumnSchema | null {
        return this.#catalog.resolveColumn(table, columnName);
    }
}

export function createCatalogAlias(input: {
    from: readonly string[];
    to: readonly string[];
}): CatalogTableAlias {
    return {
        from: createIdentifierPath(...input.from),
        to: createIdentifierPath(...input.to),
    };
}
