import { AuthDiagnosticsReadScope, USAGE_EXPORT_PATH, UsageDay } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import { authenticateRawRouteWithScope } from "../auth/http.ts";
import { requestUrl } from "../requestUrl.ts";
import * as UsageService from "./UsageService.ts";

const decodeDay = Schema.decodeUnknownOption(UsageDay);

const badRequest = (detail: string) => HttpServerResponse.text(detail, { status: 400 });

/**
 * `until` defaults to today and `timeZone` to the server's. Not an MCP tool: a week runs to tens
 * of megabytes.
 */
export const layer = HttpRouter.add(
  "GET",
  USAGE_EXPORT_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthDiagnosticsReadScope);
    const url = requestUrl(yield* HttpServerRequest.HttpServerRequest);
    if (Option.isNone(url)) return badRequest("Bad Request");
    const params = url.value.searchParams;
    const zoneId = params.get("timeZone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const zone = DateTime.zoneMakeNamed(zoneId);
    if (Option.isNone(zone)) return badRequest(`timeZone ${zoneId} is not an IANA time zone.`);
    const sinceDay = decodeDay(params.get("since"));
    if (Option.isNone(sinceDay)) return badRequest("since must be a day, YYYY-MM-DD.");
    const until = params.get("until");
    const untilDay =
      until === null
        ? decodeDay(DateTime.formatIsoDate(DateTime.setZone(yield* DateTime.now, zone.value)))
        : decodeDay(until);
    if (Option.isNone(untilDay)) return badRequest("until must be a day, YYYY-MM-DD.");

    const usage = yield* UsageService.UsageService;
    return yield* usage
      .readRecords({ sinceDay: sinceDay.value, untilDay: untilDay.value, timeZone: zoneId })
      .pipe(
        Effect.map((records) =>
          HttpServerResponse.stream(
            Stream.fromIterable(records).pipe(
              Stream.map((record) => `${JSON.stringify(record)}\n`),
              Stream.encodeText,
            ),
            { contentType: "application/x-ndjson", headers: { "cache-control": "no-store" } },
          ),
        ),
        Effect.catchTags({
          UsageReadError: (error) =>
            Effect.succeed(
              HttpServerResponse.text(error.message, {
                status: error.reason === "invalidWindow" ? 400 : 500,
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
