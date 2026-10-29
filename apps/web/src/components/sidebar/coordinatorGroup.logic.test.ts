import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  coordinatorGroupSlot,
  inferFirstMateCoordinatorOf,
  isAppCrewmate,
  resolveAppCoordinatorGroup,
  resolveCoordinatorGroup,
  resolveLaunchCoordinator,
  soleCoordinator,
} from "./coordinatorGroup.logic";

const environmentId = EnvironmentId.make("environment-local");
const homeId = ProjectId.make("project-home");
const appId = ProjectId.make("project-app");

const project = (
  id: ProjectId,
  workspaceRoot: string,
  repositoryName: string | null = null,
  repositoryRoot = workspaceRoot,
) => ({
  environmentId,
  id,
  workspaceRoot,
  repositoryIdentity:
    repositoryName === null
      ? null
      : {
          canonicalKey: `github.com/someone/${repositoryName}`,
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: `https://github.com/someone/${repositoryName}`,
          },
          name: repositoryName,
          rootPath: repositoryRoot,
        },
});

const thread = (
  title: string,
  overrides: {
    projectId?: ProjectId;
    worktreePath?: string | null;
    createdAt?: string;
    archivedAt?: string | null;
    viaMcp?: boolean;
    /** The signed-in MCP client that launched it. */
    from?: string;
    status?: "running" | "idle" | "completed" | "cancelled" | "failed" | null;
    updatedAt?: string;
  } = {},
) => ({
  environmentId,
  id: ThreadId.make(title),
  projectId: overrides.projectId ?? homeId,
  title,
  worktreePath: overrides.worktreePath ?? null,
  createdAt: overrides.createdAt ?? "2026-10-28T10:00:00.000Z",
  archivedAt: overrides.archivedAt ?? null,
  linkOrigin:
    overrides.from === undefined
      ? null
      : {
          sessionId: `session-${overrides.from}`,
          label: overrides.from,
          access: "full-access" as const,
          linked: false,
        },
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
  source:
    overrides.viaMcp === false
      ? { createdBy: "user" as const, creationSource: "web" as const }
      : { createdBy: "agent" as const, creationSource: "mcp" as const },
});

const home = project(homeId, "/work/firstmate");
const app = project(appId, "/work/app");

describe("resolveCoordinatorGroup", () => {
  const named = (links: Record<string, string>) => (subject: { id: string }) =>
    links[subject.id] === undefined ? null : ThreadId.make(links[subject.id]!);

  it("groups the unarchived threads naming a coordinator under it", () => {
    const lead = thread("lead");
    const live = thread("live");
    const done = thread("done", { archivedAt: "2026-10-28T11:00:00.000Z" });
    const other = thread("other");
    const group = resolveCoordinatorGroup(
      [lead, live, done, other],
      named({ live: "lead", done: "lead" }),
    );
    expect([...group.coordinators]).toEqual([lead]);
    expect([...group.crew]).toEqual([live]);
  });

  it("keeps a coordinator once its only crewmate is archived", () => {
    const lead = thread("lead");
    const done = thread("done", { archivedAt: "2026-10-28T11:00:00.000Z" });
    const group = resolveCoordinatorGroup([lead, done], named({ done: "lead" }));
    expect([...group.coordinators]).toEqual([lead]);
    expect(group.crew.size).toBe(0);
  });

  it("ignores links to archived or unknown coordinators", () => {
    const lead = thread("lead", { archivedAt: "2026-10-28T11:00:00.000Z" });
    const worker = thread("worker");
    const stray = thread("stray");
    const group = resolveCoordinatorGroup(
      [lead, worker, stray],
      named({ worker: "lead", stray: "missing" }),
    );
    expect(group.coordinators.size).toBe(0);
    expect(group.crew.size).toBe(0);
  });

  it("lists a coordinator that is itself crew with the crew", () => {
    const lead = thread("lead");
    const second = thread("second");
    const nested = thread("nested");
    const group = resolveCoordinatorGroup(
      [lead, second, nested],
      named({ second: "lead", nested: "second" }),
    );
    expect([...group.coordinators]).toEqual([lead]);
    expect([...group.crew]).toEqual([second, nested]);
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

describe("inferFirstMateCoordinatorOf", () => {
  const groupOf = (
    threads: readonly ReturnType<typeof thread>[],
    projects: readonly ReturnType<typeof project>[],
  ) => resolveCoordinatorGroup(threads, inferFirstMateCoordinatorOf(threads, projects));

  it("puts the main session on top with every crewmate, in any project", () => {
    const main = thread("Captain's session", { viaMcp: false });
    const crewInHome = thread("Fix the docs", {
      from: "firstmate",
      worktreePath: "/pool/1/firstmate",
    });
    const crewElsewhere = thread("Fix the login redirect", {
      from: "firstmate",
      projectId: appId,
      worktreePath: "/pool/2/app",
    });
    const userThread = thread("Refactor login", { projectId: appId, viaMcp: false });
    const group = groupOf([main, crewInHome, crewElsewhere, userThread], [home, app]);
    expect([...group.coordinators]).toEqual([main]);
    expect([...group.crew]).toEqual([crewInHome, crewElsewhere]);
  });

  it("keeps the main session on top before its first crewmate", () => {
    const main = thread("Captain's session", { viaMcp: false });
    const group = groupOf([main], [project(homeId, "/work/crew-home", "FirstMate")]);
    expect([...group.coordinators]).toEqual([main]);
  });

  it("picks the newest main session and skips worktree, archived and crewmate threads", () => {
    const older = thread("Old session", { viaMcp: false, createdAt: "2026-10-27T10:00:00.000Z" });
    const newer = thread("New session", { viaMcp: false, createdAt: "2026-10-28T09:00:00.000Z" });
    const worktree = thread("Side branch", {
      viaMcp: false,
      worktreePath: "/pool/3/firstmate",
      createdAt: "2026-10-28T11:00:00.000Z",
    });
    const archived = thread("Archived", {
      viaMcp: false,
      archivedAt: "2026-10-28T12:00:00.000Z",
      createdAt: "2026-10-28T12:00:00.000Z",
    });
    const secondmate = thread("Secondmate", {
      from: "firstmate",
      createdAt: "2026-10-28T13:00:00.000Z",
    });
    const group = groupOf([older, newer, worktree, archived, secondmate], [home]);
    expect([...group.coordinators]).toEqual([newer]);
    expect([...group.crew]).toEqual([secondmate]);
  });

  it("only treats FirstMate's agent launches as crewmates", () => {
    const main = thread("Captain's session", { viaMcp: false });
    const typedByUser = thread("fm-notes", { projectId: appId, viaMcp: false });
    const otherAgent = thread("Delegated review", { projectId: appId });
    const otherClient = thread("Review the login", { projectId: appId, from: "claude-code" });
    expect(groupOf([main, typedByUser, otherAgent, otherClient], [home, app]).crew.size).toBe(0);
  });

  it("still treats a launch from before client origins, titled fm-, as a crewmate", () => {
    const main = thread("Captain's session", { viaMcp: false });
    const legacy = thread("fm-app-login", { projectId: appId, worktreePath: "/pool/2/app" });
    expect([...groupOf([main, legacy], [home, app]).crew]).toEqual([legacy]);
  });

  it("does not treat a folder inside a FirstMate checkout as a home", () => {
    const nested = project(appId, "/work/crew-home/data/app", "firstmate", "/work/crew-home");
    const session = thread("Refactor login", { projectId: appId, viaMcp: false });
    expect(groupOf([session], [nested]).coordinators.size).toBe(0);
  });

  it("forms no group without a FirstMate home and main session", () => {
    const crewLookalike = thread("fm-task", { projectId: appId });
    const userThread = thread("Refactor login", { projectId: appId, viaMcp: false });
    for (const group of [
      groupOf([crewLookalike, userThread], [app]),
      groupOf([crewLookalike], [home, app]),
    ]) {
      expect(group.coordinators.size).toBe(0);
      expect(group.crew.size).toBe(0);
    }
  });
});

describe("isAppCrewmate", () => {
  const crewmatesOf = (
    threads: readonly ReturnType<typeof thread>[],
    projects: readonly ReturnType<typeof project>[] = [home, app],
  ) =>
    threads
      .filter((subject) => isAppCrewmate(threads, projects, subject.environmentId, subject.id))
      .map((subject) => subject.title);

  it("silences crewmates in any project and leaves FirstMate and other threads notifying", () => {
    const main = thread("Captain's session", { viaMcp: false });
    const crewInHome = thread("Fix the docs", {
      from: "firstmate",
      worktreePath: "/pool/1/firstmate",
    });
    const crewElsewhere = thread("fm-app-login", { projectId: appId, worktreePath: "/pool/2/app" });
    const userThread = thread("Refactor login", { projectId: appId, viaMcp: false });
    expect(crewmatesOf([main, crewInHome, crewElsewhere, userThread])).toEqual([
      "Fix the docs",
      "fm-app-login",
    ]);
  });

  it("silences nothing without a FirstMate main session", () => {
    const crewLookalike = thread("fm-task", { projectId: appId });
    const userThread = thread("Refactor login", { projectId: appId, viaMcp: false });
    expect(crewmatesOf([crewLookalike, userThread], [app])).toEqual([]);
  });
});

describe("resolveLaunchCoordinator", () => {
  const launchOf = (
    threads: readonly ReturnType<typeof thread>[],
    projects: readonly ReturnType<typeof project>[] = [home, app],
  ) => resolveLaunchCoordinator(resolveAppCoordinatorGroup(threads, projects));

  it.each([
    ["working", "running"],
    ["waiting on its background work", "idle"],
    ["finished its turn", "completed"],
    ["cancelled by a restart", "cancelled"],
    ["failed", "failed"],
    ["never run", null],
  ] as const)("opens a FirstMate main session that is %s", (_name, status) => {
    const main = thread("Captain's session", { viaMcp: false, status });
    const crewmate = thread("fm-docs-fix", { worktreePath: "/pool/1/firstmate" });
    expect(launchOf([main, crewmate])).toBe(main);
  });

  it("opens nothing when the FirstMate main session is archived", () => {
    const main = thread("Captain's session", {
      viaMcp: false,
      status: "idle",
      archivedAt: "2026-10-28T11:00:00.000Z",
    });
    const crewmate = thread("fm-docs-fix", { worktreePath: "/pool/1/firstmate" });
    expect(launchOf([main, crewmate])).toBeNull();
  });

  it("opens nothing without FirstMate, however busy other threads are", () => {
    const busy = thread("Refactor login", { projectId: appId, viaMcp: false, status: "running" });
    expect(launchOf([busy], [app])).toBeNull();
  });

  it("opens the most recently updated of several coordinators", () => {
    const older = thread("older", { status: "running", updatedAt: "2026-10-28T09:00:00.000Z" });
    const recent = thread("recent", { status: "idle", updatedAt: "2026-10-28T12:00:00.000Z" });
    const group = resolveCoordinatorGroup([older, recent], (subject) => subject.id);
    expect(resolveLaunchCoordinator(group)).toBe(recent);
  });
});

describe("soleCoordinator", () => {
  it("names the only FirstMate main session, whose card drops its title", () => {
    const main = thread("Captain's session", { viaMcp: false });
    const crewmate = thread("fm-docs-fix", { worktreePath: "/pool/1/firstmate" });
    expect(soleCoordinator(resolveAppCoordinatorGroup([main, crewmate], [home]))).toBe(main);
  });

  it("names none of several coordinators, so their titles tell them apart", () => {
    const first = thread("first");
    const second = thread("second");
    const group = resolveCoordinatorGroup([first, second], (subject) => subject.id);
    expect(soleCoordinator(group)).toBeNull();
  });

  it("names none without FirstMate", () => {
    const userThread = thread("Refactor login", { projectId: appId, viaMcp: false });
    expect(soleCoordinator(resolveAppCoordinatorGroup([userThread], [app]))).toBeNull();
  });
});
