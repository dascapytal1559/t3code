import {
  CommandId,
  EventId,
  MessageId,
  TurnId,
  type SharedThreadHistory,
  type ThreadId,
  type InternalOrchestrationCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const TextItem = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
  ),
});
const NativeTurnUuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
);
const decodeNativeTurnUuid = Schema.decodeUnknownOption(NativeTurnUuid);
const decodeItem = Schema.decodeUnknownOption(TextItem);

/** Native IDs make repeated refreshes use the same durable command receipt. */
export function sharedHistoryCommand(
  threadId: ThreadId,
  nativeThreadId: string,
  turn: SharedThreadHistory["turns"][number],
  observedAt: string,
): Extract<InternalOrchestrationCommand, { type: "thread.history.sync" }> {
  const key = `codex-shared:${threadId}:${nativeThreadId}:${turn.id}`;
  // Codex turn IDs are UUIDv7. Their millisecond timestamp orders desktop
  // turns correctly against T3 messages within the same rounded API second.
  const uuid = decodeNativeTurnUuid(turn.id);
  const milliseconds =
    uuid._tag === "Some"
      ? Number.parseInt(uuid.value.slice(0, 13).replace("-", ""), 16)
      : turn.startedAt === null
        ? undefined
        : turn.startedAt * 1000;
  const createdAt =
    milliseconds === undefined ? observedAt : DateTime.formatIso(DateTime.makeUnsafe(milliseconds));
  const messages = turn.items.flatMap((raw, index) => {
    const parsed = decodeItem(raw);
    if (parsed._tag === "None") return [];
    const item = parsed.value;
    if (item.type !== "userMessage" && item.type !== "agentMessage") return [];
    const text =
      item.text ??
      item.content
        ?.map(
          (part) =>
            part.text ?? (part.type === "image" || part.type === "localImage" ? "[Image]" : ""),
        )
        .join("\n") ??
      "";
    return [
      {
        messageId: MessageId.make(`${key}:${String(index).padStart(10, "0")}:${item.id}`),
        role: item.type === "userMessage" ? ("user" as const) : ("assistant" as const),
        text,
        createdAt,
      },
    ];
  });
  return {
    type: "thread.history.sync",
    commandId: CommandId.make(key),
    threadId,
    turnId: TurnId.make(turn.id),
    messages,
    activity: {
      id: EventId.make(key),
      tone: "info",
      kind: "shared.conversation.turn",
      summary: `Turn ${turn.status} in Codex`,
      turnId: TurnId.make(turn.id),
      createdAt,
      payload: { nativeThreadId, ...turn },
    },
    createdAt,
  };
}
