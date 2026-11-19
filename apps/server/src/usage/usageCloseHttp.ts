import { AuthEnvironmentMaintainScope, USAGE_CLOSE_PATH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import { authenticateRawRouteWithScope } from "../auth/http.ts";
import { requestUrl } from "../requestUrl.ts";
import * as UsageService from "./UsageService.ts";

const decodeThrough = Schema.decodeUnknownOption(Schema.FiniteFromString.check(Schema.isInt()));

/** A route, not an MCP tool: writing labels down for good is an operator's call, not an agent's. */
export const layer = HttpRouter.add(
  "POST",
  USAGE_CLOSE_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthEnvironmentMaintainScope);
    const url = requestUrl(yield* HttpServerRequest.HttpServerRequest);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const params = url.value.searchParams;
    const throughMs = decodeThrough(params.get("through"));
    if (Option.isNone(throughMs))
      return HttpServerResponse.text("through must be a time in epoch milliseconds.", {
        status: 400,
      });
    const usage = yield* UsageService.UsageService;
    return yield* usage
      .closeThrough({ throughMs: throughMs.value, dryRun: params.get("dryRun") === "1" })
      .pipe(
        Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
        Effect.catchTags({
          UsageCloseError: (error) =>
            Effect.succeed(
              HttpServerResponse.text(error.message, {
                status: error.reason === "failed" ? 500 : 409,
              }),
            ),
        }),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);
