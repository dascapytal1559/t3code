// Fork: Remote host on thread cards (FORK_FEATURES.md).
import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assignRemoteEnvironmentColors,
  REMOTE_ENVIRONMENT_COLOR_SEQUENCE,
} from "./environmentColors";

const id = (value: string) => value as EnvironmentId;

describe("assignRemoteEnvironmentColors", () => {
  it("deals distinct colors in catalog order", () => {
    const colors = assignRemoteEnvironmentColors([id("zdata"), id("bsc"), id("vps")]);
    expect([...colors.entries()]).toEqual([
      ["zdata", "blue"],
      ["bsc", "orange"],
      ["vps", "emerald"],
    ]);
  });

  it("keeps a host's color when a later host is removed", () => {
    const before = assignRemoteEnvironmentColors([id("zdata"), id("bsc"), id("vps")]);
    const after = assignRemoteEnvironmentColors([id("zdata"), id("vps")]);
    expect(after.get(id("zdata"))).toBe(before.get(id("zdata")));
    expect(after.get(id("vps"))).toBe("orange");
  });

  it("ignores duplicate ids and wraps once the sequence is exhausted", () => {
    const ids = REMOTE_ENVIRONMENT_COLOR_SEQUENCE.map((_, index) => id(`host-${index}`));
    const colors = assignRemoteEnvironmentColors([...ids, id("host-0"), id("extra")]);
    expect(colors.size).toBe(ids.length + 1);
    expect(colors.get(id("extra"))).toBe(REMOTE_ENVIRONMENT_COLOR_SEQUENCE[0]);
  });

  it("returns an empty map with no remotes", () => {
    expect(assignRemoteEnvironmentColors([]).size).toBe(0);
  });
});
