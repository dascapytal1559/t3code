// @effect-diagnostics nodeBuiltinImport:off
// Kind of work: which user-named group the project a usage record ran in belongs to.
import type {
  ProjectId,
  UsageProviderKind,
  UsageWorkGroup,
  UsageWorkMember,
  UsageWorkMemberLabel,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeStream from "node:stream";
import * as NodeSqlite from "node:sqlite";
import * as NodeZlib from "node:zlib";

/** A T3 project by the folder it is rooted at. */
export interface WorkProject {
  readonly id: ProjectId;
  readonly root: string;
  /** The project's name, for its member row; its folder name when absent. */
  readonly title?: string;
}

/** A worktree a T3 thread ran in, as T3 recorded it: still known once the folder is gone. */
export interface WorkWorktree {
  readonly path: string;
  readonly projectId: ProjectId;
}

export const USAGE_SESSION_FOLDERS_FILE_NAME = "usage-session-folders.json";

/** Claude's name for a working folder: each character but a letter or digit becomes `-`. */
export const encodeClaudeFolder = (folder: string) => folder.replace(/[^a-zA-Z0-9]/g, "-");

/** The entry for `folder` or its closest parent folder that has one. */
const nearest = <T>(index: ReadonlyMap<string, T>, folder: string) => {
  for (let at = NodePath.resolve(folder); ; at = NodePath.dirname(at)) {
    const found = index.get(at);
    if (found !== undefined) return { folder: at, value: found };
    if (NodePath.dirname(at) === at) return undefined;
  }
};

/** Folder levels from `root` down to `folder`, which it holds. */
const levelsBelow = (root: string, folder: string) => {
  const rest = NodePath.relative(root, folder);
  return rest === "" ? 0 : rest.split(NodePath.sep).length;
};

/** A group's folder entries, `~` expanded; a folder two groups list counts to the first. */
function workFolderEntries(
  groups: readonly UsageWorkGroup[],
  homeDir: string,
): readonly { readonly folder: string; readonly group: string; readonly entry: string }[] {
  const entries = new Map<string, { readonly group: string; readonly entry: string }>();
  for (const group of groups) {
    for (const folder of group.folders ?? []) {
      const expanded =
        folder === "~" || folder.startsWith("~/") ? homeDir + folder.slice(1) : folder;
      if (!NodePath.isAbsolute(expanded)) continue;
      const resolved = NodePath.resolve(expanded);
      if (!entries.has(resolved)) entries.set(resolved, { group: group.name, entry: folder });
    }
  }
  return [...entries]
    .map(([folder, { group, entry }]) => ({ folder, group, entry }))
    .sort((a, b) => b.folder.length - a.folder.length);
}

/** The member key of a folder entry, as `UsageWorkGroup.hiddenMembers` lists it. */
const folderMemberKey = (entry: string) => `folder:${entry}`;

/** Groups the Usage page can open into members: not shared, and not switched off. */
const opensIntoMembers = (group: UsageWorkGroup) =>
  group.shared !== true && group.opensIntoMembers !== false;

/** What clients spread over the other groups: shared groups' names, `""` for Other. */
export const sharedWorkOf = (groups: readonly UsageWorkGroup[], shareOther: boolean) => [
  ...groups.flatMap((group) => (group.shared === true ? [group.name] : [])),
  ...(shareOther ? [""] : []),
];

/** Whether any group counts usage: one with a project or a folder in it. */
export const groupsPlaceWork = (groups: readonly UsageWorkGroup[]) =>
  groups.some((group) => group.projectIds.length > 0 || (group.folders?.length ?? 0) > 0);

/** Reads the `gitdir:` line of a linked worktree's `.git` file. */
async function readGitFile(gitFile: string): Promise<string | null> {
  const text = await NodeFSP.readFile(gitFile, "utf8").catch(() => null);
  const match = text?.match(/^gitdir:\s*(.+)$/m);
  return match === undefined || match === null
    ? null
    : NodePath.resolve(NodePath.dirname(gitFile), match[1]!.trim());
}

/** The main working tree of the repository whose git directory is `gitDir`, or null for a bare one. */
async function mainWorkingTree(gitDir: string): Promise<string | null> {
  const common = await NodeFSP.readFile(NodePath.join(gitDir, "commondir"), "utf8").catch(
    () => null,
  );
  const commonDir = common === null ? gitDir : NodePath.resolve(gitDir, common.trim());
  return NodePath.basename(commonDir) === ".git" ? NodePath.dirname(commonDir) : null;
}

/**
 * The folder as it sits in its repository's main working tree, so a worktree's folder and the
 * repository's own one are the same. A folder in no repository, or in a bare one, stays as is.
 */
export async function canonicalFolder(folder: string): Promise<string> {
  for (let dir = folder; ;) {
    const gitPath = NodePath.join(dir, ".git");
    const stat = await NodeFSP.lstat(gitPath).catch(() => null);
    if (stat !== null) {
      if (stat.isDirectory()) return folder;
      const gitDir = await readGitFile(gitPath);
      const main = gitDir === null ? null : await mainWorkingTree(gitDir);
      return main === null ? folder : NodePath.join(main, NodePath.relative(dir, folder));
    }
    const parent = NodePath.dirname(dir);
    if (parent === dir) return folder;
    dir = parent;
  }
}

/** Linked worktrees of the repository at `root`, from its git directory's `worktrees` entries. */
async function linkedWorktrees(root: string): Promise<readonly string[]> {
  const gitDir = NodePath.join(root, ".git");
  const entries = await NodeFSP.readdir(NodePath.join(gitDir, "worktrees")).catch(() => []);
  const worktrees = await Promise.all(
    entries.map(async (entry) => {
      const text = await NodeFSP.readFile(
        NodePath.join(gitDir, "worktrees", entry, "gitdir"),
        "utf8",
      ).catch(() => null);
      return text === null ? null : NodePath.dirname(text.trim());
    }),
  );
  return worktrees.filter((worktree): worktree is string => worktree !== null);
}

/**
 * Reads `cwd` from the first line of a Codex session, compressed or not; null when it has none,
 * undefined when the session could not be read.
 */
export async function readCodexSessionFolder(filePath: string): Promise<string | null | undefined> {
  const file = NodeFS.createReadStream(filePath);
  const input = filePath.endsWith(".zst")
    ? NodeStream.pipeline(file, NodeZlib.createZstdDecompress(), () => undefined)
    : file;
  const lines = NodeReadline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const payload = (JSON.parse(line) as { payload?: { cwd?: unknown } }).payload;
      return typeof payload?.cwd === "string" && payload.cwd !== "" ? payload.cwd : null;
    }
    return null;
  } catch {
    return undefined;
  } finally {
    lines.close();
    file.destroy();
  }
}

/** no-mistakes' repositories by id, from its own database, read-only; empty when it has none. */
function readNoMistakesRepos(homeDir: string): ReadonlyMap<string, string> {
  const dbPath = NodePath.join(homeDir, ".no-mistakes", "state.sqlite");
  if (!NodeFS.existsSync(dbPath)) return new Map();
  try {
    const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT id, working_path FROM repos").all() as {
        id: string;
        working_path: string;
      }[];
      return new Map(rows.map((row) => [row.id, row.working_path]));
    } finally {
      db.close();
    }
  } catch {
    return new Map();
  }
}

export interface UsageWorkOptions {
  readonly homeDir: string;
  /** Where the folders read from Codex sessions' first lines are kept. */
  readonly foldersCachePath: string;
  readonly readNoMistakesRepos?: (homeDir: string) => ReadonlyMap<string, string>;
  readonly readCodexSessionFolder?: (filePath: string) => Promise<string | null | undefined>;
}

/** What a read needs to place its records: the folders and transcripts it saw. */
export interface WorkFolders {
  readonly cwds: ReadonlySet<string>;
  /** Transcripts holding records without a folder of their own. */
  readonly files: ReadonlyMap<
    string,
    { readonly provider: UsageProviderKind; readonly sourceDir: string }
  >;
}

/** Where a record counts: its group, and the member in it when that group opens into members. */
export interface WorkPlace {
  readonly group: string;
  readonly member: string | null;
}

/** A read's placement of records in groups, by the record's folder or else its transcript's. */
export interface WorkAttribution {
  readonly groups: readonly string[];
  readonly placeOf: (cwd: string | undefined, filePath: string | undefined) => WorkPlace | null;
  /** The members places name, labelled; only those of groups that open into members. */
  readonly members: readonly UsageWorkMember[];
}

const NO_MISTAKES_RETRY_MS = 60_000;

/**
 * Keeps what never changes across reads: folders resolved to their repository, Codex sessions'
 * first-line folders (also on disk), and Claude folder names decoded to real ones.
 */
export function makeUsageWork(options: UsageWorkOptions) {
  const { homeDir } = options;
  const readRepos = options.readNoMistakesRepos ?? readNoMistakesRepos;
  const readCodexFolder = options.readCodexSessionFolder ?? readCodexSessionFolder;
  const canonical = new Map<string, Promise<string>>();
  const canonicalOf = (folder: string) => {
    let pending = canonical.get(folder);
    if (pending === undefined) {
      pending = canonicalFolder(folder);
      canonical.set(folder, pending);
    }
    return pending;
  };

  let codexFolders: Map<string, string | null> | null = null;
  const loadCodexFolders = async () => {
    if (codexFolders !== null) return codexFolders;
    const text = await NodeFSP.readFile(options.foldersCachePath, "utf8").catch(() => null);
    let saved: Record<string, string | null> = {};
    try {
      const parsed = text === null ? null : (JSON.parse(text) as { folders?: unknown });
      if (typeof parsed?.folders === "object" && parsed.folders !== null) {
        saved = parsed.folders as Record<string, string | null>;
      }
    } catch {
      // A damaged file is read again from the sessions.
    }
    codexFolders = new Map(
      Object.entries(saved).filter(([, value]) => value === null || typeof value === "string"),
    );
    return codexFolders;
  };
  const saveCodexFolders = async (folders: ReadonlyMap<string, string | null>) => {
    await NodeFSP.mkdir(NodePath.dirname(options.foldersCachePath), { recursive: true });
    const temp = `${options.foldersCachePath}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
    await NodeFSP.writeFile(
      temp,
      JSON.stringify({ version: 1, folders: Object.fromEntries(folders) }),
    );
    await NodeFSP.rename(temp, options.foldersCachePath);
  };

  let noMistakes: {
    readonly repos: ReadonlyMap<string, string>;
    readonly readAtMs: number;
  } | null = null;
  let nowMs = 0;
  const noMistakesRepo = (id: string) => {
    const now = nowMs;
    if (
      noMistakes === null ||
      (!noMistakes.repos.has(id) && now - noMistakes.readAtMs > NO_MISTAKES_RETRY_MS)
    ) {
      noMistakes = { repos: readRepos(homeDir), readAtMs: now };
    }
    return noMistakes.repos.get(id);
  };
  const noMistakesHome = NodePath.join(homeDir, ".no-mistakes");
  const noMistakesPath = new RegExp(
    `^${escapeRegExp(noMistakesHome)}[\\\\/](?:worktrees[\\\\/]([0-9a-f]+)|repos[\\\\/]([0-9a-f]+)\\.git)(?:[\\\\/]|$)`,
  );
  const noMistakesEncoded = new RegExp(
    `^${escapeRegExp(encodeClaudeFolder(noMistakesHome))}-(?:worktrees-([0-9a-f]+)|repos-([0-9a-f]+)-git)(?:-|$)`,
  );
  // A pipeline review runs in no-mistakes' own checkout of a repository: count it to that repository.
  const reviewedRepo = (match: RegExpExecArray | null) =>
    match === null ? undefined : noMistakesRepo(match[1] ?? match[2]!);
  // Only the review's own folder, so a folder entry on the repository does not take reviews.
  const reviewFolder = (match: RegExpExecArray) =>
    match[1] === undefined
      ? NodePath.join(noMistakesHome, "repos", `${match[2]!}.git`)
      : NodePath.join(noMistakesHome, "worktrees", match[1]);

  // Claude names decode against the folders they could have come from: projects and their worktrees.
  let decoder: { readonly key: string; readonly candidates: readonly [string, string][] } | null =
    null;
  const decoded = new Map<string, string | null>();
  const decoderFor = async (
    projects: readonly WorkProject[],
    threadWorktrees: readonly WorkWorktree[],
    folders: readonly string[],
  ) => {
    const key = [
      ...projects.map((project) => project.root),
      ...threadWorktrees.map((w) => w.path),
      ...folders,
    ].join("\0");
    if (decoder?.key === key) return decoder;
    const roots = [...new Set(projects.map((project) => project.root))];
    const worktrees = (await Promise.all(roots.map(linkedWorktrees))).flat();
    const candidates = [
      ...new Set([
        ...roots,
        ...worktrees,
        ...threadWorktrees.map((worktree) => worktree.path),
        ...folders,
      ]),
    ]
      .map((folder): [string, string] => [encodeClaudeFolder(folder), folder])
      .sort((a, b) => b[0].length - a[0].length);
    decoded.clear();
    decoder = { key, candidates };
    return decoder;
  };
  // Claude writes '/' and '-' alike, so a name longer than a candidate's may be one of its
  // folders or a sibling, such as `app-web` for `app`. A sibling on disk rules the candidate out;
  // with neither on disk, the folder is gone and the candidate stays the best guess.
  const decode = async (name: string, candidates: readonly [string, string][]) => {
    if (decoded.has(name)) return decoded.get(name)!;
    const review = noMistakesEncoded.exec(name);
    let found = review === null ? null : reviewFolder(review);
    for (const [encoded, folder] of review === null ? candidates : []) {
      if (name !== encoded && !name.startsWith(encoded + "-")) continue;
      const rest = name.slice(encoded.length + 1);
      if (
        name !== encoded &&
        !(await hasEncodedFolder(folder, rest)) &&
        (await hasEncodedFolder(
          NodePath.dirname(folder),
          `${encodeClaudeFolder(NodePath.basename(folder))}-${rest}`,
        ))
      )
        continue;
      found = folder;
      break;
    }
    decoded.set(name, found);
    return found;
  };

  /** Folders from Codex sessions' first lines; each session is read once it can be read, ever. */
  const codexFoldersFor = async (paths: readonly string[]) => {
    const folders = await loadCodexFolders();
    const unread = paths.filter((filePath) => !folders.has(filePath));
    if (unread.length > 0) {
      const read = await mapLimit(unread, 8, readCodexFolder);
      let added = false;
      unread.forEach((filePath, index) => {
        const folder = read[index];
        if (folder === undefined) return;
        folders.set(filePath, folder);
        added = true;
      });
      if (added) await saveCodexFolders(folders).catch(() => undefined);
    }
    return folders;
  };

  const attribution = async (
    groups: readonly UsageWorkGroup[],
    memberLabel: UsageWorkMemberLabel,
    projects: readonly WorkProject[],
    worktrees: readonly WorkWorktree[],
    seen: WorkFolders,
    readAtMs: number,
  ): Promise<WorkAttribution> => {
    nowMs = readAtMs;
    const groupByProject = new Map<ProjectId, string>();
    for (const group of groups) {
      for (const projectId of group.projectIds) {
        if (!groupByProject.has(projectId)) groupByProject.set(projectId, group.name);
      }
    }
    const names = [...new Set(groups.map((group) => group.name))];
    const opening = new Set(groups.filter(opensIntoMembers).map((group) => group.name));
    const folderEntries = workFolderEntries(groups, homeDir);
    if (groupByProject.size === 0 && folderEntries.length === 0) {
      return { groups: names, placeOf: () => null, members: [] };
    }

    const roots = await Promise.all(
      projects.map(async (project) => ({ id: project.id, root: await canonicalOf(project.root) })),
    );
    const projectByRoot = new Map<string, ProjectId>();
    for (const { id, root } of roots) {
      const key = NodePath.resolve(root);
      if (!projectByRoot.has(key)) projectByRoot.set(key, id);
    }
    // A thread's worktree stands for its project's folder, so a removed worktree still places.
    const rootOf = new Map(projects.map((project) => [project.id, project.root]));
    const worktreeRoots = new Map<string, string>();
    for (const worktree of worktrees) {
      const root = rootOf.get(worktree.projectId);
      const key = NodePath.resolve(worktree.path);
      if (root !== undefined && !worktreeRoots.has(key)) worktreeRoots.set(key, root);
    }
    const entryByFolder = new Map(folderEntries.map((entry) => [entry.folder, entry]));
    const inProject = (folder: string) => {
      const worktree = nearest(worktreeRoots, folder);
      return worktree === undefined
        ? folder
        : NodePath.join(worktree.value, NodePath.relative(worktree.folder, folder));
    };
    const memberIn = (group: string, member: string): WorkPlace => ({
      group,
      member: opening.has(group) ? member : null,
    });
    // The closest entry wins: a folder entry by the folder itself, a project also by its worktrees.
    const groupOfFolder = async (folder: string): Promise<WorkPlace | null> => {
      const entry = nearest(entryByFolder, folder)?.value;
      const repo = reviewedRepo(noMistakesPath.exec(folder));
      const placed = await canonicalOf(repo ?? inProject(folder));
      const project = nearest(projectByRoot, placed);
      if (
        entry !== undefined &&
        (project === undefined ||
          levelsBelow(entry.folder, folder) <= levelsBelow(project.folder, placed))
      ) {
        return memberIn(entry.group, folderMemberKey(entry.entry));
      }
      const group = project === undefined ? undefined : groupByProject.get(project.value);
      return project === undefined || group === undefined ? null : memberIn(group, project.value);
    };

    const byCwd = new Map<string, WorkPlace | null>();
    await Promise.all([...seen.cwds].map(async (cwd) => byCwd.set(cwd, await groupOfFolder(cwd))));
    const codexPaths = [...seen.files].flatMap(([filePath, file]) =>
      file.provider === "codex" ? [filePath] : [],
    );
    const codex = codexPaths.length === 0 ? null : await codexFoldersFor(codexPaths);
    const claudeNames = [...seen.files].some(([, file]) => file.provider === "claude")
      ? (
          await decoderFor(
            projects,
            worktrees,
            folderEntries.map((entry) => entry.folder),
          )
        ).candidates
      : [];
    const byFile = new Map<string, WorkPlace | null>();
    await Promise.all(
      [...seen.files].map(async ([filePath, file]) => {
        const folder =
          file.provider === "codex"
            ? (codex?.get(filePath) ?? null)
            : file.provider === "claude"
              ? await decode(claudeFolderName(filePath, file.sourceDir), claudeNames)
              : null;
        byFile.set(filePath, folder === null ? null : await groupOfFolder(folder));
      }),
    );
    // Every member a place can name: by project name, or by its repository's folder name.
    const rootById = new Map(roots.map((project) => [project.id, project.root]));
    const groupByName = new Map(groups.map((group) => [group.name, group]));
    // A group lists either the members to show or the members to hide.
    const isHidden = (key: string, groupName: string) => {
      const group = groupByName.get(groupName);
      return group?.shownMembers !== undefined
        ? !group.shownMembers.includes(key)
        : group?.hiddenMembers?.includes(key) === true;
    };
    const member = (key: string, group: string, name: string): UsageWorkMember => ({
      key,
      group,
      name,
      ...(isHidden(key, group) ? { hidden: true as const } : {}),
    });
    const members: UsageWorkMember[] = [];
    for (const project of projects) {
      const group = groupByProject.get(project.id);
      if (group === undefined || !opening.has(group)) continue;
      const repository = NodePath.basename(rootById.get(project.id) ?? project.root);
      const name = memberLabel === "repository" ? repository : (project.title ?? repository);
      members.push(member(project.id, group, name));
    }
    for (const entry of folderEntries) {
      if (!opening.has(entry.group)) continue;
      members.push(
        member(folderMemberKey(entry.entry), entry.group, NodePath.basename(entry.folder)),
      );
    }
    return {
      groups: names,
      placeOf: (cwd, filePath) =>
        cwd !== undefined
          ? (byCwd.get(cwd) ?? null)
          : filePath === undefined
            ? null
            : (byFile.get(filePath) ?? null),
      members,
    };
  };

  return { attribution };
}

export type UsageWork = ReturnType<typeof makeUsageWork>;

/** Whether a folder inside `folder` encodes, relative to it, as `rest`. */
async function hasEncodedFolder(folder: string, rest: string): Promise<boolean> {
  const children = await NodeFSP.readdir(folder, { withFileTypes: true }).catch(() => []);
  for (const child of children) {
    const path = NodePath.join(folder, child.name);
    const isFolder =
      child.isDirectory() ||
      (child.isSymbolicLink() &&
        (await NodeFSP.stat(path).then(
          (stat) => stat.isDirectory(),
          () => false,
        )));
    if (!isFolder) continue;
    const encoded = encodeClaudeFolder(child.name);
    if (rest === encoded) return true;
    if (
      rest.startsWith(encoded + "-") &&
      (await hasEncodedFolder(path, rest.slice(encoded.length + 1)))
    )
      return true;
  }
  return false;
}

/** The first folder below Claude's projects folder: the encoded working folder. */
const claudeFolderName = (filePath: string, sourceDir: string) =>
  NodePath.relative(sourceDir, filePath).split(NodePath.sep)[0] ?? "";

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function mapLimit<A, B>(
  items: readonly A[],
  limit: number,
  run: (item: A) => Promise<B>,
): Promise<B[]> {
  const results: B[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}
