// @effect-diagnostics nodeBuiltinImport:off
// Fork: Shared Codex desktop backend (FORK_FEATURES.md).
import * as NodeStream from "node:stream";
import { describe, expect, it } from "vite-plus/test";
import { relayStdio } from "./transport.ts";
class Socket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
  receive(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}
describe("shared protocol client", () => {
  it("blocks account mutations and ignores another client's server requests", async () => {
    const socket = new Socket();
    const input = new NodeStream.PassThrough();
    const output = new NodeStream.PassThrough();
    let received = "";
    output.on("data", (value) => {
      received += String(value);
    });
    const relayed = relayStdio(socket as unknown as WebSocket, input, output, true);
    input.write(JSON.stringify({ id: 1, method: "account/login/start", params: {} }) + "\n");
    socket.receive({
      id: "external",
      method: "item/tool/requestUserInput",
      params: { turnId: "desktop-turn" },
    });
    input.write(JSON.stringify({ id: 2, method: "turn/start", params: {} }) + "\n");
    socket.receive({ id: 2, result: { turn: { id: "t3-turn" } } });
    socket.receive({
      id: "own",
      method: "item/tool/requestUserInput",
      params: { turnId: "t3-turn" },
    });
    input.end();
    await relayed;
    expect(socket.sent.map((line) => JSON.parse(line).method)).toEqual(["turn/start"]);
    expect(received).toContain("Shared mode uses the Codex app's account");
    expect(received).not.toContain("external");
    expect(received).toContain('"own"');
  });
});
