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
  // What an agent claimed for Usage: a session or folder run outside T3, or a T3 run (turn),
  // counted to the prompt that caused it or straight to a device.
  const claimColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(usage_claims)`;
  const outdated = claimColumns.length > 0 && !claimColumns.some(({ name }) => name === "device");
  yield* sql.withTransaction(
    Effect.gen(function* () {
      // SQLite can't change a CHECK in place, so the first claims table is rebuilt once.
      if (outdated) yield* sql`ALTER TABLE usage_claims RENAME TO usage_claims_before_devices`;
      yield* sql`
        CREATE TABLE IF NOT EXISTS usage_claims (
          target_kind TEXT NOT NULL CHECK (target_kind IN ('session', 'directory', 'run')),
          target TEXT NOT NULL,
          cause_thread_id TEXT,
          cause_run_id TEXT,
          cause_message_id TEXT,
          device TEXT CHECK (device IN ('phone', 'computer')),
          claimed_at TEXT NOT NULL,
          PRIMARY KEY (target_kind, target),
          CHECK ((cause_message_id IS NULL) <> (device IS NULL))
        )
      `;
      if (!outdated) return;
      yield* sql`
        INSERT INTO usage_claims
          (target_kind, target, cause_thread_id, cause_run_id, cause_message_id, claimed_at)
        SELECT target_kind, target, cause_thread_id, cause_run_id, cause_message_id, claimed_at
        FROM usage_claims_before_devices
      `;
      yield* sql`DROP TABLE usage_claims_before_devices`;
    }),
  );
});
