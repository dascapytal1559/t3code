// @effect-diagnostics nodeBuiltinImport:off
// Kind of work: which user-named group the project a usage record ran in belongs to.
import type { ProjectId, UsageProviderKind, UsageWorkGroup } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeSqlite from "node:sqlite";
import * as NodeZlib from "node:zlib";

/** A T3 project by the folder it is rooted at. */
export interface WorkProject {
  readonly id: ProjectId;
  readonly root: string;
}

/** A worktree a T3 thread ran in, as T3 recorded it: still known once the folder is gone. */
export interface WorkWorktree {
  readonly path: string;
  readonly projectId: ProjectId;
}

export const USAGE_SESSION_FOLDERS_FILE_NAME = "usage-session-folders.json";

/** Claude's name for a working folder: each character but a letter or digit becomes `-`. */
export const encodeClaudeFolder = (folder: string) => folder.replace(/[^a-zA-Z0-9]/g, "-");

const isWithin = (folder: string, root: string) =>
  folder === root || folder.startsWith(root.endsWith(NodePath.sep) ? root : root + NodePath.sep);

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

/** Reads `cwd` from the first line of a Codex session, compressed or not; null when it has none. */
export async function readCodexSessionFolder(filePath: string): Promise<string | null> {
  const file = NodeFS.createReadStream(filePath);
  const input = filePath.endsWith(".zst") ? file.pipe(NodeZlib.createZstdDecompress()) : file;
  const lines = NodeReadline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const payload = (JSON.parse(line) as { payload?: { cwd?: unknown } }).payload;
      return typeof payload?.cwd === "string" && payload.cwd !== "" ? payload.cwd : null;
    }
    return null;
  } catch {
    return null;
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
  readonly readCodexSessionFolder?: (filePath: string) => Promise<string | null>;
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

/** A read's placement of records in groups, by the record's folder or else its transcript's. */
export interface WorkAttribution {
  readonly groups: readonly string[];
  readonly groupOf: (cwd: string | undefined, filePath: string | undefined) => string | null;
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
    const temp = `${options.foldersCachePath}.${process.pid}.tmp`;
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
    `^${escapeRegExp(noMistakesHome)}/(?:worktrees/([0-9a-f]+)|repos/([0-9a-f]+)\\.git)(?:/|$)`,
  );
  const noMistakesEncoded = new RegExp(
    `^${escapeRegExp(encodeClaudeFolder(noMistakesHome))}-(?:worktrees-([0-9a-f]+)|repos-([0-9a-f]+)-git)(?:-|$)`,
  );
  // A pipeline review runs in no-mistakes' own checkout of a repository: count it to that repository.
  const reviewedRepo = (match: RegExpExecArray | null) =>
    match === null ? undefined : noMistakesRepo(match[1] ?? match[2]!);

  // Claude names decode against the folders they could have come from: projects and their worktrees.
  let decoder: { readonly key: string; readonly candidates: readonly [string, string][] } | null =
    null;
  const decoded = new Map<string, string | null>();
  const decoderFor = async (
    projects: readonly WorkProject[],
    threadWorktrees: readonly WorkWorktree[],
  ) => {
    const key = [
      ...projects.map((project) => project.root),
      ...threadWorktrees.map((w) => w.path),
    ].join("\0");
    if (decoder?.key === key) return decoder;
    const roots = [...new Set(projects.map((project) => project.root))];
    const worktrees = (await Promise.all(roots.map(linkedWorktrees))).flat();
    const candidates = [
      ...new Set([...roots, ...worktrees, ...threadWorktrees.map((worktree) => worktree.path)]),
    ]
      .map((folder): [string, string] => [encodeClaudeFolder(folder), folder])
      .sort((a, b) => b[0].length - a[0].length);
    decoded.clear();
    decoder = { key, candidates };
    return decoder;
  };
  const decode = (name: string, candidates: readonly [string, string][]) => {
    if (decoded.has(name)) return decoded.get(name)!;
    const repo = reviewedRepo(noMistakesEncoded.exec(name));
    const found =
      repo ??
      candidates.find(([encoded]) => name === encoded || name.startsWith(encoded + "-"))?.[1] ??
      null;
    decoded.set(name, found);
    return found;
  };

  /** Folders from Codex sessions' first lines; each session is read once, ever. */
  const codexFoldersFor = async (paths: readonly string[]) => {
    const folders = await loadCodexFolders();
    const unread = paths.filter((filePath) => !folders.has(filePath));
    if (unread.length > 0) {
      const read = await mapLimit(unread, 8, readCodexFolder);
      unread.forEach((filePath, index) => folders.set(filePath, read[index] ?? null));
      await saveCodexFolders(folders).catch(() => undefined);
    }
    return folders;
  };

  const attribution = async (
    groups: readonly UsageWorkGroup[],
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
    if (groupByProject.size === 0) return { groups: names, groupOf: () => null };

    const roots = await Promise.all(
      projects.map(async (project) => ({ id: project.id, root: await canonicalOf(project.root) })),
    );
    roots.sort((a, b) => b.root.length - a.root.length);
    // A thread's worktree stands for its project's folder, so a removed worktree still places.
    const rootOf = new Map(projects.map((project) => [project.id, project.root]));
    const threadWorktrees = worktrees
      .flatMap((worktree) => {
        const root = rootOf.get(worktree.projectId);
        return root === undefined ? [] : [{ path: worktree.path, root }];
      })
      .sort((a, b) => b.path.length - a.path.length);
    const inProject = (folder: string) => {
      const worktree = threadWorktrees.find((candidate) => isWithin(folder, candidate.path));
      return worktree === undefined
        ? folder
        : NodePath.join(worktree.root, NodePath.relative(worktree.path, folder));
    };
    const groupOfFolder = async (folder: string) => {
      const repo = reviewedRepo(noMistakesPath.exec(folder));
      const placed = await canonicalOf(repo ?? inProject(folder));
      const project = roots.find((candidate) => isWithin(placed, candidate.root));
      return project === undefined ? null : (groupByProject.get(project.id) ?? null);
    };

    const byCwd = new Map<string, string | null>();
    await Promise.all([...seen.cwds].map(async (cwd) => byCwd.set(cwd, await groupOfFolder(cwd))));
    const codexPaths = [...seen.files].flatMap(([filePath, file]) =>
      file.provider === "codex" ? [filePath] : [],
    );
    const codex = codexPaths.length === 0 ? null : await codexFoldersFor(codexPaths);
    const claudeNames = [...seen.files].some(([, file]) => file.provider === "claude")
      ? (await decoderFor(projects, worktrees)).candidates
      : [];
    const byFile = new Map<string, string | null>();
    await Promise.all(
      [...seen.files].map(async ([filePath, file]) => {
        const folder =
          file.provider === "codex"
            ? (codex?.get(filePath) ?? null)
            : file.provider === "claude"
              ? decode(claudeFolderName(filePath, file.sourceDir), claudeNames)
              : null;
        byFile.set(filePath, folder === null ? null : await groupOfFolder(folder));
      }),
    );
    return {
      groups: names,
      groupOf: (cwd, filePath) =>
        cwd !== undefined
          ? (byCwd.get(cwd) ?? null)
          : filePath === undefined
            ? null
            : (byFile.get(filePath) ?? null),
    };
  };

  return { attribution };
}

export type UsageWork = ReturnType<typeof makeUsageWork>;

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
