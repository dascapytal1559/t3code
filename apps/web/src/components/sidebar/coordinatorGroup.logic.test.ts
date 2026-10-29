import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  coordinatorGroupSlot,
  inferFirstMateCoordinatorOf,
  resolveAppCoordinatorGroup,
  resolveCoordinatorGroup,
  resolveLaunchCoordinator,
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
    status?: "running" | "idle" | "completed" | "failed" | null;
    updatedAt?: string;
    hasPendingApprovals?: boolean;
    blockedOnThreadWait?: boolean;
  } = {},
) => ({
  environmentId,
  id: ThreadId.make(title),
  projectId: overrides.projectId ?? homeId,
  title,
  worktreePath: overrides.worktreePath ?? null,
  createdAt: overrides.createdAt ?? "2026-10-28T10:00:00.000Z",
  archivedAt: overrides.archivedAt ?? null,
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
  hasPendingApprovals: overrides.hasPendingApprovals ?? false,
  hasPendingUserInput: false,
  blockedOnThreadWait: overrides.blockedOnThreadWait ?? false,
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
    const crewInHome = thread("fm-docs-fix", { worktreePath: "/pool/1/firstmate" });
    const crewElsewhere = thread("fm-app-login", { projectId: appId, worktreePath: "/pool/2/app" });
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
    const secondmate = thread("fm-secondmate", { createdAt: "2026-10-28T13:00:00.000Z" });
    const group = groupOf([older, newer, worktree, archived, secondmate], [home]);
    expect([...group.coordinators]).toEqual([newer]);
    expect([...group.crew]).toEqual([secondmate]);
  });

  it("only treats agent-launched fm- threads as crewmates", () => {
    const main = thread("Captain's session", { viaMcp: false });
    const typedByUser = thread("fm-notes", { projectId: appId, viaMcp: false });
    const otherAgent = thread("Delegated review", { projectId: appId });
    expect(groupOf([main, typedByUser, otherAgent], [home, app]).crew.size).toBe(0);
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

describe("resolveLaunchCoordinator", () => {
  const launchOf = (
    threads: readonly ReturnType<typeof thread>[],
    projects: readonly ReturnType<typeof project>[] = [home, app],
  ) => resolveLaunchCoordinator(resolveAppCoordinatorGroup(threads, projects));

  it.each([
    ["working", { status: "running" }],
    ["waiting on its background work", { status: "idle" }],
    ["waiting on a crewmate", { status: "running", blockedOnThreadWait: true }],
    ["asking for approval", { status: "running", hasPendingApprovals: true }],
  ] as const)("opens a FirstMate main session that is %s", (_name, state) => {
    const main = thread("Captain's session", { viaMcp: false, ...state });
    const crewmate = thread("fm-docs-fix", {
      worktreePath: "/pool/1/firstmate",
      status: "running",
    });
    expect(launchOf([main, crewmate])).toBe(main);
  });

  it.each([
    ["finished its turn", "completed"],
    ["failed", "failed"],
    ["never run", null],
  ] as const)("leaves a main session that has %s closed", (_name, status) => {
    const main = thread("Captain's session", { viaMcp: false, status });
    const crewmate = thread("fm-docs-fix", {
      worktreePath: "/pool/1/firstmate",
      status: "running",
    });
    expect(launchOf([main, crewmate])).toBeNull();
  });

  it("opens nothing without FirstMate, however busy other threads are", () => {
    const busy = thread("Refactor login", { projectId: appId, viaMcp: false, status: "running" });
    expect(launchOf([busy], [app])).toBeNull();
  });

  it("opens the most recently updated of several live coordinators", () => {
    const quiet = thread("quiet", { status: "idle", updatedAt: "2026-10-28T09:00:00.000Z" });
    const recent = thread("recent", { status: "running", updatedAt: "2026-10-28T11:00:00.000Z" });
    const finished = thread("finished", {
      status: "completed",
      updatedAt: "2026-10-28T12:00:00.000Z",
    });
    const group = resolveCoordinatorGroup([quiet, recent, finished], (subject) => subject.id);
    expect(resolveLaunchCoordinator(group)).toBe(recent);
  });
});
