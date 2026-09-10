// Fork: Fork a thread (FORK_FEATURES.md) — the pure cutoff and id rules every
// projector shares.
import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  forkedEntityId,
  forkKeepsRow,
  resolveForkCutoff,
  resolveForkCutoffAt,
} from "./threadFork.ts";

const turn = (turnId: string | null, checkpointTurnCount: number | null) => ({
  turnId: turnId === null ? null : TurnId.make(turnId),
  checkpointTurnCount,
});

describe("resolveForkCutoff", () => {
  it("keeps turns through the fork turn and uses its checkpoint count", () => {
    const cutoff = resolveForkCutoff(
      [turn("t1", 1), turn("t2", 2), turn("t3", 3)],
      TurnId.make("t2"),
    );
    expect(cutoff).not.toBeNull();
    expect([...cutoff!.retainedTurnIds]).toEqual(["t1", "t2"]);
    expect(cutoff!.turnCount).toBe(2);
  });

  it("falls back to the turn's position when it was never checkpointed", () => {
    const cutoff = resolveForkCutoff(
      [turn(null, null), turn("t1", null), turn("t2", null)],
      TurnId.make("t2"),
    );
    expect(cutoff?.turnCount).toBe(2);
    expect([...cutoff!.retainedTurnIds]).toEqual(["t1", "t2"]);
  });

  it("returns null when the fork turn is not a turn of the source", () => {
    expect(resolveForkCutoff([turn("t1", 1)], TurnId.make("missing"))).toBeNull();
  });
});

describe("resolveForkCutoffAt", () => {
  const timed = (turnId: string | null, requestedAt: string) => ({
    turnId: turnId === null ? null : TurnId.make(turnId),
    requestedAt,
  });

  it("cuts at the request time of the first turn after the fork turn", () => {
    expect(
      resolveForkCutoffAt(
        [
          timed("t1", "2026-03-01T12:00:01.000Z"),
          timed("t2", "2026-03-01T12:00:05.000Z"),
          timed("t3", "2026-03-01T12:00:09.000Z"),
        ],
        TurnId.make("t2"),
      ),
    ).toBe("2026-03-01T12:00:09.000Z");
  });

  it("counts a pending turn that has no id yet, whatever the input order", () => {
    // The turn repository lists checkpointed turns first, so a later pending
    // row can precede the fork turn in the input.
    expect(
      resolveForkCutoffAt(
        [
          timed(null, "2026-03-01T12:00:09.000Z"),
          timed("t2", "2026-03-01T12:00:05.000Z"),
          timed("t1", "2026-03-01T12:00:01.000Z"),
          timed("t3", "2026-03-01T12:00:12.000Z"),
        ],
        TurnId.make("t2"),
      ),
    ).toBe("2026-03-01T12:00:09.000Z");
  });

  it("is null when the fork turn is the source's last, or unknown", () => {
    expect(
      resolveForkCutoffAt(
        [timed("t1", "2026-03-01T12:00:01.000Z"), timed("t2", "2026-03-01T12:00:05.000Z")],
        TurnId.make("t2"),
      ),
    ).toBeNull();
    expect(
      resolveForkCutoffAt([timed("t1", "2026-03-01T12:00:01.000Z")], TurnId.make("missing")),
    ).toBeNull();
  });
});

describe("forkKeepsRow", () => {
  it("keeps rows created before the cut and everything when there is no cut", () => {
    expect(forkKeepsRow("2026-03-01T12:00:09.000Z", "2026-03-01T12:00:08.999Z")).toBe(true);
    expect(forkKeepsRow("2026-03-01T12:00:09.000Z", "2026-03-01T12:00:09.000Z")).toBe(false);
    expect(forkKeepsRow(null, "2099-01-01T00:00:00.000Z")).toBe(true);
  });
});

describe("forkedEntityId", () => {
  it("is deterministic per fork and distinct across forks", () => {
    const forkA = ThreadId.make("fork-a");
    const forkB = ThreadId.make("fork-b");
    expect(forkedEntityId(forkA, "msg-1")).toBe(forkedEntityId(forkA, "msg-1"));
    expect(forkedEntityId(forkA, "msg-1")).not.toBe(forkedEntityId(forkB, "msg-1"));
    expect(forkedEntityId(forkA, "msg-1")).not.toBe(forkedEntityId(forkA, "msg-2"));
    expect(forkedEntityId(forkA, "msg-1")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
