import { describe, expect, it } from "@effect/vitest";
import {
  AuthDiagnosticsReadScope,
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  USAGE_EXPORT_PATH,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as UsageService from "./UsageService.ts";
import * as UsageExportHttp from "./usageExportHttp.ts";

const exportWith = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Effect.gen(function* () {
    const routes = UsageExportHttp.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            authenticateHttpRequest: () =>
              Effect.succeed({
                sessionId: AuthSessionId.make("usage-export-test"),
                subject: "test",
                method: "bearer-access-token",
                scopes,
                deviceType: "desktop",
              }),
          }),
          Layer.mock(UsageService.UsageService)({ readRecords: () => Effect.succeed([]) }),
        ),
      ),
    );
    const { handler } = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      (web) => Effect.promise(() => web.dispose()),
    );
    return yield* Effect.promise(() =>
      handler(
        new Request(
          `http://127.0.0.1:3773${USAGE_EXPORT_PATH}?since=2026-11-10&until=2026-11-12&timeZone=UTC`,
        ),
      ),
    );
  });

describe("GET usage export", () => {
  // The Usage page's own summary needs diagnostics:read; the export carries more than it does.
  it.effect("refuses a session that can only read orchestration", () =>
    Effect.gen(function* () {
      const response = yield* exportWith([AuthOrchestrationReadScope]);
      expect(response.status).toBe(403);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        code: "insufficient_scope",
        requiredPermission: AuthDiagnosticsReadScope,
      });
    }),
  );

  it.effect("streams records to a session that can read diagnostics", () =>
    Effect.gen(function* () {
      const response = yield* exportWith([AuthDiagnosticsReadScope]);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    }),
  );
});
