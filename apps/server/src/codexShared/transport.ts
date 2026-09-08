// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// Standalone launch boundary: runs before T3 and owns native process pipes.
import * as NodeEvents from "node:events";
import * as NodeReadline from "node:readline";
import * as NodeStream from "node:stream";
import * as Schema from "effect/Schema";

const Message = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
const decodeTurn = Schema.decodeUnknownSync(
  Schema.Struct({ turn: Schema.Struct({ id: Schema.String }) }),
);
const decodeMessage = Schema.decodeUnknownSync(Schema.fromJsonString(Message));

export async function openWebSocket(url: string, signal?: AbortSignal): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      socket.close();
      reject(signal?.reason ?? new Error("Connection cancelled"));
    };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    socket.addEventListener(
      "open",
      () => {
        cleanup();
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        cleanup();
        reject(new Error("Shared Codex backend is unavailable."));
      },
      { once: true },
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  return socket;
}

export async function withSharedRpc<A>(
  url: string,
  use: (request: (method: string, params: unknown) => Promise<unknown>) => Promise<A>,
): Promise<A> {
  const socket = await openWebSocket(url, AbortSignal.timeout(10_000));
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 10_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = decodeMessage(String(event.data));
    } catch {
      for (const call of pending.values())
        call.reject(new Error("Codex sent invalid protocol data."));
      pending.clear();
      socket.close();
      return;
    }
    if (typeof message.id !== "number" || message.method) return;
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const call of pending.values()) call.reject(new Error("Shared Codex connection closed."));
    pending.clear();
  });
  try {
    await request("initialize", {
      clientInfo: { name: "t3_shared_backend_control", version: "1" },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: "initialized" }));
    return await use(request);
  } finally {
    socket.close();
  }
}

/** One WebSocket per protocol client; the native server owns request routing. */
export async function relayStdio(
  socket: WebSocket,
  input: NodeStream.Readable,
  output: NodeStream.Writable,
  fixedAccount: boolean,
): Promise<void> {
  const lines = NodeReadline.createInterface({ input });
  const closed = new Promise<void>((resolve, reject) => {
    socket.addEventListener(
      "close",
      () => {
        lines.close();
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        lines.close();
        reject(new Error("Shared Codex connection failed."));
      },
      { once: true },
    );
  });
  const turnRequests = new Set<string | number>();
  const ownedTurns = new Set<string>();
  let writes = Promise.resolve();
  socket.addEventListener("message", (event) => {
    if (fixedAccount) {
      try {
        const message = decodeMessage(String(event.data));
        if (
          message.id !== undefined &&
          !message.method &&
          turnRequests.delete(message.id) &&
          !message.error
        ) {
          ownedTurns.add(decodeTurn(message.result).turn.id);
        }
        if (message.method === "turn/completed")
          ownedTurns.delete(decodeTurn(message.params).turn.id);
        if (message.id !== undefined && message.method) {
          // This connection subscribes to its task and child agents. While its
          // own turn runs, requests may belong to a child or omit a turn ID.
          // An idle observer must never answer another client's requests.
          if (turnRequests.size === 0 && ownedTurns.size === 0) return;
        }
      } catch {
        socket.close();
        return;
      }
    }
    writes = writes
      .then(async () => {
        if (!output.write(String(event.data) + "\n"))
          await NodeEvents.EventEmitter.once(output, "drain");
      })
      .catch(() => {
        socket.close();
      });
  });
  lines.on("line", (line) => {
    try {
      const message = decodeMessage(line);
      if (
        fixedAccount &&
        (message.method === "account/login/start" || message.method === "account/logout")
      ) {
        output.write(
          JSON.stringify({
            id: message.id,
            error: {
              code: -32600,
              message: "Shared mode uses the Codex app's account. Change accounts in Codex.",
            },
          }) + "\n",
        );
      } else if (socket.readyState === WebSocket.OPEN) {
        if (message.method === "turn/start" && message.id !== undefined)
          turnRequests.add(message.id);
        socket.send(line);
      }
    } catch {
      socket.close();
    }
  });
  const stop = () => socket.close();
  lines.once("close", stop);
  output.on("error", stop);
  try {
    await closed;
    await writes;
  } finally {
    output.off("error", stop);
    lines.close();
  }
}
