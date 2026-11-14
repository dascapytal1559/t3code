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
  // A usage session or folder an agent ran outside T3, claimed for the prompt that caused it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS usage_claims (
      target_kind TEXT NOT NULL CHECK (target_kind IN ('session', 'directory')),
      target TEXT NOT NULL,
      cause_thread_id TEXT NOT NULL,
      cause_run_id TEXT,
      cause_message_id TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      PRIMARY KEY (target_kind, target)
    )
  `;
});
