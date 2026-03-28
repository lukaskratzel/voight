import { createTableSchema, InMemoryCatalog } from "./catalog";

export function createTestCatalog(): InMemoryCatalog {
    return new InMemoryCatalog([
        createTableSchema({
            id: "users",
            path: ["users"],
            columns: ["id", "name", "email", "age", "tenant_id", "created_at"],
        }),
        createTableSchema({
            id: "profiles",
            path: ["profiles"],
            columns: ["user_id", "display_name", "deleted_at"],
        }),
        createTableSchema({
            id: "orders",
            path: ["orders"],
            columns: ["id", "user_id", "total", "total_cents", "tenant_id", "status", "created_at"],
        }),
        createTableSchema({
            id: "internal_projects",
            path: ["internal_projects"],
            columns: ["id", "name", "tenant_id", "created_at"],
        }),
        createTableSchema({
            id: "timeseries",
            path: ["timeseries"],
            columns: ["id", "tenant_id", "metric", "timestamp", "value"],
        }),
    ]);
}
