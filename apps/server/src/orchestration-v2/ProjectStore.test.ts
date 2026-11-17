import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureForkSchema } from "../persistence/forkSchema.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";

it.layer(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "ProjectStoreV2",
  (it) => {
    it.effect("stores a model selection without options as JSON without an options key", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-null-options");
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("event-null-options"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Null options project",
            workspaceRoot: "/tmp/project-null-options",
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });

        const rows = yield* sql<{ readonly defaultModelSelection: string | null }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM projection_projects
          WHERE project_id = ${projectId}
        `;
        assert.strictEqual(rows[0]?.defaultModelSelection, JSON.stringify(modelSelection));
        assert.deepStrictEqual(
          Option.getOrNull(yield* projects.get(projectId))?.defaultModelSelection,
          modelSelection,
        );
      }),
    );

    it.effect("keeps pin and archive times across later updates", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const projectId = ProjectId.make("project-organized");
        const at = "2026-03-24T00:00:00.000Z";
        const event = { aggregateKind: "project", aggregateId: projectId, occurredAt: at } as const;
        const meta = { commandId: null, causationEventId: null, correlationId: null, metadata: {} };
        yield* projects.apply({
          ...event,
          ...meta,
          sequence: 1,
          eventId: EventId.make("event-organized-created"),
          type: "project.created",
          payload: {
            projectId,
            title: "Organized",
            workspaceRoot: "/tmp/project-organized",
            defaultModelSelection: null,
            scripts: [],
            createdAt: at,
            updatedAt: at,
          },
        });
        yield* projects.apply({
          ...event,
          ...meta,
          sequence: 2,
          eventId: EventId.make("event-organized-pinned"),
          type: "project.meta-updated",
          payload: { projectId, pinnedAt: at, archivedAt: at, updatedAt: at },
        });
        yield* projects.apply({
          ...event,
          ...meta,
          sequence: 3,
          eventId: EventId.make("event-organized-renamed"),
          type: "project.meta-updated",
          payload: { projectId, title: "Renamed", updatedAt: at },
        });
        const project = Option.getOrNull(yield* projects.get(projectId));
        assert.strictEqual(project?.pinnedAt, at);
        assert.strictEqual(project?.archivedAt, at);
      }),
    );

    it.effect("marks a project's title as custom only once it is renamed", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const projectId = ProjectId.make("project-renamed");
        const event = {
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
        } as const;
        const hasCustomTitle = () =>
          projects
            .getShell(projectId)
            .pipe(Effect.map((shell) => Option.getOrNull(shell)?.hasCustomTitle));
        yield* projects.apply({
          ...event,
          sequence: 1,
          eventId: EventId.make("event-renamed-created"),
          type: "project.created",
          payload: {
            projectId,
            title: "repo",
            workspaceRoot: "/tmp/repo",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });
        assert.strictEqual(yield* hasCustomTitle(), false);
        yield* projects.apply({
          ...event,
          sequence: 2,
          eventId: EventId.make("event-renamed-title"),
          type: "project.meta-updated",
          payload: { projectId, title: "custom repo", updatedAt: "2026-03-24T00:00:02.000Z" },
        });
        assert.strictEqual(yield* hasCustomTitle(), true);
        yield* projects.apply({
          ...event,
          sequence: 3,
          eventId: EventId.make("migration:39:project:project-renamed:baseline"),
          type: "project.created",
          payload: {
            projectId,
            title: "repo",
            workspaceRoot: "/tmp/repo",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:03.000Z",
          },
        });
        assert.strictEqual(yield* hasCustomTitle(), true);
        assert.strictEqual(
          Option.getOrNull(yield* projects.getShell(projectId))?.title,
          "custom repo",
        );
      }),
    );

    it.effect("turns an old cache-expiry size floor into the cache-expiry choice", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const at = "2026-03-24T00:00:00.000Z";
        const create = (id: string, sequence: number) =>
          projects.apply({
            sequence,
            eventId: EventId.make(`event-${id}`),
            aggregateKind: "project",
            aggregateId: ProjectId.make(id),
            occurredAt: at,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId: ProjectId.make(id),
              title: id,
              workspaceRoot: `/tmp/${id}`,
              defaultModelSelection: null,
              scripts: [],
              createdAt: at,
              updatedAt: at,
            },
          });
        yield* create("project-floor", 1);
        yield* create("project-no-floor", 2);
        yield* sql`ALTER TABLE projection_projects DROP COLUMN clear_after_quiet_json`;
        yield* sql`ALTER TABLE projection_projects ADD COLUMN cold_clear_min_tokens INTEGER`;
        yield* sql`
          UPDATE projection_projects SET cold_clear_min_tokens = 60000
          WHERE project_id = 'project-floor'
        `;

        yield* ensureForkSchema();

        const clearAfterQuiet = (id: string) =>
          projects
            .getShell(ProjectId.make(id))
            .pipe(Effect.map((shell) => Option.getOrNull(shell)?.clearAfterQuiet));
        assert.strictEqual(yield* clearAfterQuiet("project-floor"), "cache");
        assert.strictEqual(yield* clearAfterQuiet("project-no-floor"), null);
        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_projects)
        `;
        assert.isFalse(columns.some(({ name }) => name === "cold_clear_min_tokens"));
        yield* projects.apply({
          sequence: 3,
          eventId: EventId.make("event-project-floor-minutes"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-floor"),
          occurredAt: at,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.meta-updated",
          payload: {
            projectId: ProjectId.make("project-floor"),
            clearAfterQuiet: 10,
            updatedAt: at,
          },
        });
        assert.strictEqual(yield* clearAfterQuiet("project-floor"), 10);
      }),
    );
  },
);
