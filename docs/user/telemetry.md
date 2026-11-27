# Product usage data and diagnostics

This fork's server and desktop app send no product usage events and no relay connection traces unless you [turn them on](#turn-telemetry-on). When on, they help keep the app reliable and fast. Prompts, responses, file contents, and credentials are never included (unless you explicitly approve an [agent feedback](#agent-feedback) card with conversation text attached).

## Product usage events

When turned on, the server sends usage events to `ingest.t3.codes` under a hashed random install ID (plus a hashed T3 Connect account ID when signed in, and random client device IDs). Events contain provider, catalog model name (non-catalog models report as custom), reasoning effort, permission mode, turn/request outcome, duration, release channel, and token counts.

## Turn telemetry on

- **Server / CLI**: Set `T3CODE_TELEMETRY_ENABLED=true` before starting; unset or `false` keeps it off. `DO_NOT_TRACK=1` wins over `T3CODE_TELEMETRY_ENABLED=true`.
- **Desktop app**: The app starts its server before it reads your shell profile, so an export in `~/.zshrc` takes effect from the app's next launch, once it has remembered the value. For it to take effect at once on macOS, run `launchctl setenv T3CODE_TELEMETRY_ENABLED true` and restart the app, or start the app from a terminal that has the variable set. On Windows, set it as a user environment variable.
- **Managed policy**: Administrators can set `"telemetry": false` in [managed policy](./managed-policy.md#other-capabilities) to keep it off for servers and desktop apps.
- **Mobile app**: Toggle **Send crash reports** and **Send connection traces** separately in **Settings → About T3 Code → Diagnostics**.

## Relay connection diagnostics

When telemetry is turned on, T3 Connect sends connection timings, request paths, environment/thread IDs, and error types (no addresses, logs, or stack frames) to Axiom. `DO_NOT_TRACK=1`, `T3CODE_OTEL_SDK_DISABLED`, or `OTEL_SDK_DISABLED` keeps it off.

## Agent feedback

Optional tool for agents to report T3 Code bugs or missing capabilities. Configure in **Settings → Labs → Agent feedback**:

- **Off** (default): Feedback tools and `t3 feedback` are disabled.
- **When I ask**: Agents submit a report only when you ask, shown as an interactive approval card before anything leaves your machine.
- **Automatic**: Also sends minimal automated reports (problem kind + tool/command name only—no text or conversation) when an agent hits a T3 tool failure; enables `t3 feedback` CLI reporting (up to 10/hour).

Approval cards show exact payloads (expected/actual/workaround, turn outline with no text, and optional **Include the conversation** up to 16 KB). File paths, usernames, hostnames, git remotes, and secret-like strings are scrubbed before saving, and reports use one-off random IDs. Inspect local reports with `t3 feedback list [--json]`.

Reports travel with telemetry, so while telemetry is off in this fork an approved report stays on this machine, marked not sent.

## Agent activity for mobile notifications

**Settings → Sharing & access → Publish agent activity** sends project/thread titles, model names, and turn status to the T3 Connect relay for [mobile notifications and live activities](./mobile-notifications.md). This is independent of telemetry—turn it off directly on the host if you don't want it.

## Export diagnostics to your own OpenTelemetry receiver

Open **Settings → Maintenance → Diagnostics** (per environment) and enter OTLP HTTP endpoints (e.g. `http://localhost:4318/v1/traces`), save, and restart the server. Use **Test** to verify connectivity.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` env vars override saved settings (use `T3CODE_OTLP_HEADERS` / `T3CODE_OTLP_PROTOCOL=http/protobuf` or the standard `OTEL_EXPORTER_OTLP_*` equivalents for auth and protobuf).
