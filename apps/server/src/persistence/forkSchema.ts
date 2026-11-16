import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork columns live outside the numbered migrations: a fork migration id would collide with
// upstream's next one, and the migrator skips every id up to the highest recorded.
export const ensureForkSchema = Effect.fn("ensureForkSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  const hasProjectColumn = (column: string) => projectColumns.some(({ name }) => name === column);
  if (!hasProjectColumn("agent_name")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN agent_name TEXT`;
  }
  if (!hasProjectColumn("cold_clear_min_tokens")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN cold_clear_min_tokens INTEGER`;
  }
  if (!hasProjectColumn("lean_claude_startup")) {
    yield* sql`
      ALTER TABLE projection_projects ADD COLUMN lean_claude_startup INTEGER NOT NULL DEFAULT 0
    `;
  }
  // What an agent claimed for Usage: a session or folder run outside T3, or a T3 run (turn),
  // counted to the prompt that caused it or straight to a device. A session claim may start at a
  // time (`claimed_from`, an ISO time, or '' for the whole session).
  const claimColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(usage_claims)`;
  const hasColumn = (column: string) => claimColumns.some(({ name }) => name === column);
  const outdated = claimColumns.length > 0 && !hasColumn("claimed_from");
  const copied = sql.literal(
    `target_kind, target, cause_thread_id, cause_run_id, cause_message_id, claimed_at${
      hasColumn("device") ? ", device" : ""
    }`,
  );
  // A claim bound by value from a thread's work: its device, plus how it was read (basis, reason).
  if (claimColumns.length > 0 && !outdated && !hasColumn("bound_json")) {
    yield* sql`ALTER TABLE usage_claims ADD COLUMN bound_json TEXT`;
  }
  // The origin a scheduled task's runs count to, bound from the turn that created it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS usage_scheduled_task_origins (
      task_id TEXT PRIMARY KEY,
      origin_json TEXT NOT NULL,
      bound_at TEXT NOT NULL
    )
  `;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      // SQLite can't change a CHECK or primary key in place, so an older table is rebuilt once.
      if (outdated) yield* sql`ALTER TABLE usage_claims RENAME TO usage_claims_outdated`;
      yield* sql`
        CREATE TABLE IF NOT EXISTS usage_claims (
          target_kind TEXT NOT NULL CHECK (target_kind IN ('session', 'directory', 'run')),
          target TEXT NOT NULL,
          claimed_from TEXT NOT NULL DEFAULT '',
          cause_thread_id TEXT,
          cause_run_id TEXT,
          cause_message_id TEXT,
          device TEXT CHECK (device IN ('phone', 'computer')),
          claimed_at TEXT NOT NULL,
          bound_json TEXT,
          PRIMARY KEY (target_kind, target, claimed_from),
          CHECK ((cause_message_id IS NULL) <> (device IS NULL)),
          CHECK (claimed_from = '' OR target_kind = 'session')
        )
      `;
      if (!outdated) return;
      yield* sql`
        INSERT INTO usage_claims (${copied}) SELECT ${copied} FROM usage_claims_outdated
      `;
      yield* sql`DROP TABLE usage_claims_outdated`;
    }),
  );
});
