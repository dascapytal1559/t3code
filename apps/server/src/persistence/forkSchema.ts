import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork columns live outside the numbered migrations: a fork migration id would collide with
// upstream's next one, and the migrator skips every id up to the highest recorded.
// A current schema gets no write: CLI startup reaches here without the server's write lock.
export const ensureForkSchema = Effect.fn("ensureForkSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const existing = new Set(
    (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type IN ('table', 'index')
    `).map(({ name }) => name),
  );
  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  const hasProjectColumn = (column: string) => projectColumns.some(({ name }) => name === column);
  if (!hasProjectColumn("agent_name")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN agent_name TEXT`;
  }
  if (!hasProjectColumn("clear_after_quiet_json")) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`ALTER TABLE projection_projects ADD COLUMN clear_after_quiet_json TEXT`;
        // The size floor this replaced had no project equivalent left, so an opted-in project
        // keeps clearing on cache expiry, now at any size.
        if (!hasProjectColumn("cold_clear_min_tokens")) return;
        yield* sql`
          UPDATE projection_projects SET clear_after_quiet_json = '"cache"'
          WHERE cold_clear_min_tokens IS NOT NULL
        `;
        yield* sql`ALTER TABLE projection_projects DROP COLUMN cold_clear_min_tokens`;
      }),
    );
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
  // The origin a scheduled task's runs count to, bound from the turn that created it and again
  // by each typed edit; a run counts to the last binding made before it.
  if (!existing.has("usage_scheduled_task_bindings")) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          CREATE TABLE IF NOT EXISTS usage_scheduled_task_bindings (
            task_id TEXT NOT NULL,
            bound_at TEXT NOT NULL,
            origin_json TEXT NOT NULL,
            PRIMARY KEY (task_id, bound_at)
          )
        `;
        // That table kept only each task's latest binding, so its earlier ones are gone.
        if (!existing.has("usage_scheduled_task_origins")) return;
        yield* sql`
          INSERT INTO usage_scheduled_task_bindings (task_id, bound_at, origin_json)
          SELECT task_id, bound_at, origin_json FROM usage_scheduled_task_origins
        `;
        yield* sql`DROP TABLE usage_scheduled_task_origins`;
      }),
    );
  }
  // The daily close: labels written down once and read as stored from then on. A session's label
  // from each time it changes, each prompt's label, and how far they are written (one row).
  // `device` is where the label counts; the other columns are the label as Usage read it.
  const labelColumns = sql.literal(`
      device TEXT NOT NULL CHECK (device IN ('phone', 'computer')),
      origin TEXT NOT NULL,
      basis TEXT NOT NULL,
      reason TEXT NOT NULL,
      via TEXT,
      claim TEXT,
      folder INTEGER NOT NULL DEFAULT 0,
      registered INTEGER NOT NULL DEFAULT 0,
      cause INTEGER NOT NULL DEFAULT 0,
      root_thread_id TEXT,
      root_message_id TEXT`);
  if (!existing.has("usage_closed_session_labels")) {
    yield* sql`
      CREATE TABLE IF NOT EXISTS usage_closed_session_labels (
        session_id TEXT NOT NULL,
        from_ms INTEGER NOT NULL,
        ${labelColumns},
        run_id TEXT,
        typed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, from_ms)
      )
    `;
  }
  if (!existing.has("usage_closed_prompt_labels")) {
    yield* sql`
      CREATE TABLE IF NOT EXISTS usage_closed_prompt_labels (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT,
        created_at_ms INTEGER NOT NULL,
        ${labelColumns}
      )
    `;
  }
  if (!existing.has("usage_closed_prompt_labels_created_idx")) {
    yield* sql`
      CREATE INDEX IF NOT EXISTS usage_closed_prompt_labels_created_idx
        ON usage_closed_prompt_labels (created_at_ms)
    `;
  }
  if (!existing.has("usage_close")) {
    yield* sql`
      CREATE TABLE IF NOT EXISTS usage_close (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        closed_from_ms INTEGER NOT NULL,
        closed_through_ms INTEGER NOT NULL,
        closed_at TEXT NOT NULL
      )
    `;
  }
  // Labels written when the event that decides them happens (`UsageLabels`), in the close's shape:
  // a session's label from each time it changes, a work thread's from its birth and each move, and
  // each prompt's. The cursor row says how far they are written and from when.
  if (!existing.has("usage_session_labels")) {
    yield* sql`
      CREATE TABLE IF NOT EXISTS usage_session_labels (
        session_id TEXT NOT NULL,
        from_ms INTEGER NOT NULL,
        ${labelColumns},
        run_id TEXT,
        typed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, from_ms)
      )
    `;
  }
  if (!existing.has("usage_work_labels")) {
    yield* sql`
      CREATE TABLE IF NOT EXISTS usage_work_labels (
        thread_id TEXT NOT NULL,
        from_ms INTEGER NOT NULL,
        ${labelColumns},
        run_id TEXT,
        typed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (thread_id, from_ms)
      )
    `;
  }
  if (!existing.has("usage_prompt_labels")) {
    yield* sql`
      CREATE TABLE IF NOT EXISTS usage_prompt_labels (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT,
        created_at_ms INTEGER NOT NULL,
        ${labelColumns}
      )
    `;
  }
  if (!existing.has("usage_prompt_labels_created_idx")) {
    yield* sql`
      CREATE INDEX IF NOT EXISTS usage_prompt_labels_created_idx
        ON usage_prompt_labels (created_at_ms)
    `;
  }
  if (!existing.has("usage_label_cursor")) {
    yield* sql`
      CREATE TABLE IF NOT EXISTS usage_label_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        labelled_from_ms INTEGER NOT NULL,
        labelled_through_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
  }
  // The label pass looks up what happened in a time range (`UsageLabelStore.activeThreads`).
  // A table an upstream migration rebuilds loses its index here, and gets it back on next start.
  const timeIndexes = [
    [
      "usage_provider_turns_started_idx",
      sql`CREATE INDEX IF NOT EXISTS usage_provider_turns_started_idx
        ON orchestration_v2_projection_provider_turns (started_at)`,
    ],
    [
      "usage_provider_turns_completed_idx",
      sql`CREATE INDEX IF NOT EXISTS usage_provider_turns_completed_idx
        ON orchestration_v2_projection_provider_turns (completed_at)`,
    ],
    [
      "usage_user_messages_created_idx",
      sql`CREATE INDEX IF NOT EXISTS usage_user_messages_created_idx
        ON orchestration_v2_projection_messages (created_at) WHERE role = 'user'`,
    ],
    [
      "usage_threads_created_idx",
      sql`CREATE INDEX IF NOT EXISTS usage_threads_created_idx
        ON orchestration_v2_projection_threads (created_at)`,
    ],
  ] as const;
  for (const [name, create] of timeIndexes) if (!existing.has(name)) yield* create;
  // Audited corrections of closed labels (`t3 usage relabel`): each change set with every old value.
  if (!existing.has("usage_relabels")) {
    yield* sql`
      CREATE TABLE IF NOT EXISTS usage_relabels (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL,
        backup_path TEXT NOT NULL,
        rows_json TEXT NOT NULL,
        undone_at TEXT
      )
    `;
  }
  if (claimColumns.length > 0 && !outdated) return;
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
