import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork columns live outside the numbered migrations: a fork migration id would collide with
// upstream's next one, and the migrator skips every id up to the highest recorded.
export const ensureForkSchema = Effect.fn("ensureForkSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!projectColumns.some((column) => column.name === "agent_name")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN agent_name TEXT`;
  }
});
