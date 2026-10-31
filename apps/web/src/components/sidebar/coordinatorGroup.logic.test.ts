import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  coordinatorGroupSlot,
  crewCoordinatorOf,
  isAppCrewmate,
  resolveAppCoordinatorGroup,
  resolveCoordinatorGroup,
  resolveLaunchCoordinator,
  soleCoordinator,
} from "./coordinatorGroup.logic";

const environmentId = EnvironmentId.make("environment-local");
const homeId = ProjectId.make("project-home");
const appId = ProjectId.make("project-app");

const thread = (
  title: string,
  overrides: {
    projectId?: ProjectId;
    archivedAt?: string | null;
    /** The coordinator this thread was launched as crew of. */
    crewOf?: string;
    /** A thread with a parent that is not a coordinator link. */
    forkOf?: string;
    status?: "running" | "idle" | "completed" | "cancelled" | "failed" | null;
    updatedAt?: string;
  } = {},
) => ({
  environmentId,
  id: ThreadId.make(title),
  projectId: overrides.projectId ?? homeId,
  title,
  archivedAt: overrides.archivedAt ?? null,
  ...(overrides.crewOf === undefined ? {} : { crewOf: ThreadId.make(overrides.crewOf) }),
  lineage:
    overrides.forkOf !== undefined
      ? {
          parentThreadId: ThreadId.make(overrides.forkOf),
          relationshipToParent: "fork" as const,
          rootThreadId: ThreadId.make(overrides.forkOf),
        }
      : { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(title) },
  updatedAt: overrides.updatedAt ?? "2026-10-28T10:00:00.000Z",
  runtime:
    overrides.status === undefined || overrides.status === null
      ? null
      : {
          status: overrides.status,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("claude"),
          providerName: null,
          lastError: null,
          updatedAt: overrides.updatedAt ?? "2026-10-28T10:00:00.000Z",
        },
});

describe("resolveCoordinatorGroup", () => {
  const coordinatorOf = (subject: ReturnType<typeof thread>) =>
    subject.title.startsWith("crew-") ? ThreadId.make("main") : null;

  it("groups the unarchived threads naming a coordinator under it", () => {
    const main = thread("main");
    const crew = thread("crew-a");
    const other = thread("other");
    const group = resolveCoordinatorGroup([main, crew, other], coordinatorOf);
    expect([...group.coordinators]).toEqual([main]);
    expect([...group.crew]).toEqual([crew]);
  });

  it("keeps a coordinator once its only crewmate is archived", () => {
    const main = thread("main");
    const archived = thread("crew-a", { archivedAt: "2026-10-28T11:00:00.000Z" });
    const group = resolveCoordinatorGroup([main, archived], coordinatorOf);
    expect([...group.coordinators]).toEqual([main]);
    expect(group.crew.size).toBe(0);
  });

  it("ignores links to archived or unknown coordinators", () => {
    const archivedMain = thread("main", { archivedAt: "2026-10-28T11:00:00.000Z" });
    const crew = thread("crew-a");
    expect(resolveCoordinatorGroup([archivedMain, crew], coordinatorOf).coordinators.size).toBe(0);
    expect(resolveCoordinatorGroup([crew], coordinatorOf).coordinators.size).toBe(0);
  });

  it("lists a coordinator that is itself crew with the crew", () => {
    const main = thread("main");
    const secondmate = thread("second");
    const crew = thread("crew-of-second");
    const nested = (subject: ReturnType<typeof thread>) =>
      subject === secondmate ? main.id : subject === crew ? secondmate.id : null;
    const group = resolveCoordinatorGroup([main, secondmate, crew], nested);
    expect([...group.coordinators]).toEqual([main]);
    expect([...group.crew]).toEqual([secondmate, crew]);
  });
});

describe("coordinatorGroupSlot", () => {
  const lead = thread("lead");
  const worker = thread("worker");
  const other = thread("other");
  const group = resolveCoordinatorGroup([lead, worker, other], (subject) =>
    subject === other ? null : lead.id,
  );

  it.each([
    ["the coordinator", lead, "active", "coordinator"],
    ["a pinned coordinator", lead, "pinned", "coordinator"],
    // Running threads are "active" here; the sidebar splits Working out of them afterwards.
    ["a crewmate", worker, "active", "crew"],
    ["a pinned crewmate", worker, "pinned", "crew"],
    ["a snoozed coordinator", lead, "snoozed", null],
    ["a settled crewmate", worker, "settled", null],
    ["any other thread", other, "active", null],
  ] as const)("places %s", (_name, subject, section, slot) => {
    expect(coordinatorGroupSlot(group, subject, section)).toBe(slot);
  });
});

describe("crewCoordinatorOf", () => {
  it("names the parent a thread was launched as crew of, in any project", () => {
    const main = thread("Captain's session");
    const crewInHome = thread("Fix the docs", { crewOf: "Captain's session" });
    const crewElsewhere = thread("Fix the login redirect", {
      crewOf: "Captain's session",
      projectId: appId,
    });
    const userThread = thread("Refactor login", { projectId: appId });
    const group = resolveAppCoordinatorGroup([main, crewInHome, crewElsewhere, userThread]);
    expect([...group.coordinators]).toEqual([main]);
    expect([...group.crew]).toEqual([crewInHome, crewElsewhere]);
  });

  it("does not take a fork or a parentless thread for crew", () => {
    expect(crewCoordinatorOf(thread("Side branch", { forkOf: "Captain's session" }))).toBeNull();
    expect(crewCoordinatorOf(thread("Refactor login"))).toBeNull();
  });

  it("forms no group when no thread was launched as crew", () => {
    const group = resolveAppCoordinatorGroup([thread("a"), thread("b", { projectId: appId })]);
    expect(group.coordinators.size).toBe(0);
    expect(group.crew.size).toBe(0);
  });
});

describe("isAppCrewmate", () => {
  const crewmatesOf = (threads: readonly ReturnType<typeof thread>[]) =>
    threads
      .filter((subject) => isAppCrewmate(threads, subject.environmentId, subject.id))
      .map((subject) => subject.title);

  it("silences crewmates in any project and leaves the coordinator and other threads notifying", () => {
    const main = thread("Captain's session");
    const crewInHome = thread("Fix the docs", { crewOf: "Captain's session" });
    const crewElsewhere = thread("Login fix", { crewOf: "Captain's session", projectId: appId });
    const userThread = thread("Refactor login", { projectId: appId });
    expect(crewmatesOf([main, crewInHome, crewElsewhere, userThread])).toEqual([
      "Fix the docs",
      "Login fix",
    ]);
  });

  it("silences nothing when the coordinator is archived", () => {
    const main = thread("Captain's session", { archivedAt: "2026-10-28T11:00:00.000Z" });
    const crew = thread("Fix the docs", { crewOf: "Captain's session" });
    expect(crewmatesOf([main, crew])).toEqual([]);
  });
});

describe("resolveLaunchCoordinator", () => {
  const launchOf = (threads: readonly ReturnType<typeof thread>[]) =>
    resolveLaunchCoordinator(resolveAppCoordinatorGroup(threads));

  it.each([
    ["working", "running"],
    ["waiting on its background work", "idle"],
    ["finished its turn", "completed"],
    ["cancelled by a restart", "cancelled"],
    ["failed", "failed"],
    ["never run", null],
  ] as const)("opens a coordinator that is %s", (_name, status) => {
    const main = thread("Captain's session", { status });
    const crewmate = thread("Docs fix", { crewOf: "Captain's session" });
    expect(launchOf([main, crewmate])).toBe(main);
  });

  it("opens nothing when the coordinator is archived", () => {
    const main = thread("Captain's session", {
      status: "idle",
      archivedAt: "2026-10-28T11:00:00.000Z",
    });
    const crewmate = thread("Docs fix", { crewOf: "Captain's session" });
    expect(launchOf([main, crewmate])).toBeNull();
  });

  it("opens nothing without a coordinator, however busy other threads are", () => {
    const busy = thread("Refactor login", { projectId: appId, status: "running" });
    expect(launchOf([busy])).toBeNull();
  });

  it("opens the most recently updated of several coordinators", () => {
    const older = thread("older", { status: "running", updatedAt: "2026-10-28T09:00:00.000Z" });
    const recent = thread("recent", { status: "idle", updatedAt: "2026-10-28T12:00:00.000Z" });
    const group = resolveCoordinatorGroup([older, recent], (subject) => subject.id);
    expect(resolveLaunchCoordinator(group)).toBe(recent);
  });
});

describe("soleCoordinator", () => {
  it("names the only coordinator, whose card drops its title", () => {
    const main = thread("Captain's session");
    const crewmate = thread("Docs fix", { crewOf: "Captain's session" });
    expect(soleCoordinator(resolveAppCoordinatorGroup([main, crewmate]))).toBe(main);
  });

  it("names none of several coordinators, so their titles tell them apart", () => {
    const first = thread("first");
    const second = thread("second");
    const group = resolveCoordinatorGroup([first, second], (subject) => subject.id);
    expect(soleCoordinator(group)).toBeNull();
  });

  it("names none without a coordinator", () => {
    expect(soleCoordinator(resolveAppCoordinatorGroup([thread("Refactor login")]))).toBeNull();
  });
});
