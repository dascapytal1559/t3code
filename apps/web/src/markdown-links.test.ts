import { describe, expect, it } from "vite-plus/test";

import {
  isLocalEditorFileHref,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";
import {
  markdownFileCopyPaths,
  markdownFileEditorTarget,
  pickMarkdownFilePath,
  resolveMarkdownFileHostPath,
} from "./markdownFileHostPath";

const noPathsExist = async () => null;

describe("isLocalEditorFileHref", () => {
  it("accepts absolute file deep links of known editors", () => {
    for (const href of [
      "cursor://file/Users/me/repo/file.md:186",
      "vscode://file/Users/me/repo/file.md:3:7",
      "vscode-insiders://file/Users/me/repo/file.md",
      "VSCODE://file/C:/Users/me/repo/file.md:3",
    ]) {
      expect(isLocalEditorFileHref(href), href).toBe(true);
    }
  });

  it("rejects other hosts, userinfo, relative paths, and unknown schemes", () => {
    for (const href of [
      "cursor://anysphere.cursor-deeplink/prompt?text=hi",
      "vscode://user@file/Users/me/repo/file.md",
      "vscode://file:8080/Users/me/repo/file.md",
      "vscode://vscode-remote/ssh-remote+example.com/home/user/project",
      "cursor://file",
      "cursor:file/Users/me/repo/file.md",
      "foo://file/Users/me/repo/file.md",
      "zed://file/Users/me/repo/file.md",
      "javascript:alert(1)",
      "./file.md",
      "",
    ]) {
      expect(isLocalEditorFileHref(href), href).toBe(false);
    }
  });
});

describe("rewriteMarkdownFileUriHref", () => {
  it("normalizes file uri hrefs for windows drive paths", () => {
    expect(
      rewriteMarkdownFileUriHref(
        "file:///D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69");
  });
});

describe("relative links inside a rendered host file", () => {
  it("anchor to the file's directory while workspace membership follows cwd", () => {
    const meta = resolveMarkdownFileLinkMeta("appendix.md", "/repo", "/tmp/report");
    expect(meta).toMatchObject({
      filePath: "/tmp/report/appendix.md",
      workspaceRelativePath: null,
    });
    const inline = resolveInlineCodeFileLinkMeta("Makefile:12", "/repo", "/tmp/report");
    expect(inline).toMatchObject({ filePath: "/tmp/report/Makefile", line: 12 });
    expect(resolveMarkdownFileLinkMeta("src/main.ts", "/repo", "/repo/docs")).toMatchObject({
      filePath: "/repo/docs/src/main.ts",
      workspaceRelativePath: "docs/src/main.ts",
    });
  });

  // Fork: a document's relative paths read from its own folder only; chat keeps the workspace.
  it("read a document's paths from its own folder only", () => {
    const cases: ReadonlyArray<
      [
        label: string,
        meta: ReturnType<typeof resolveMarkdownFileLinkMeta>,
        expected: Partial<NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>>,
      ]
    > = [
      [
        "file beside",
        resolveMarkdownFileLinkMeta("notes.md", "/ws", "/ws/data/videos/scripts"),
        { filePath: "/ws/data/videos/scripts/notes.md" },
      ],
      [
        "sub-folder, inline code",
        resolveInlineCodeFileLinkMeta("sources/a.mp4", "/ws", "/ws/data/videos"),
        { filePath: "/ws/data/videos/sources/a.mp4" },
      ],
      [
        "a top-folder path in inline code reads beside the document first",
        resolveInlineCodeFileLinkMeta("data/report.md", "/ws", "/ws/data/videos/scripts"),
        {
          filePath: "/ws/data/videos/scripts/data/report.md",
          workspaceRelativePath: "data/videos/scripts/data/report.md",
          rootFallbackPath: "/ws/data/report.md",
        },
      ],
      [
        "../ path, tidied to one spelling",
        resolveMarkdownFileLinkMeta("../sources/a.mp4", "/ws", "/ws/data/videos/scripts"),
        {
          filePath: "/ws/data/videos/sources/a.mp4",
          workspaceRelativePath: "data/videos/sources/a.mp4",
        },
      ],
      [
        "explicit ./",
        resolveInlineCodeFileLinkMeta("./src/main.ts", "/ws", "/ws/docs"),
        { filePath: "/ws/docs/src/main.ts" },
      ],
      [
        "absolute path",
        resolveMarkdownFileLinkMeta("/etc/hosts", "/ws", "/ws/docs"),
        { filePath: "/etc/hosts", workspaceRelativePath: null },
      ],
      [
        "home path",
        resolveMarkdownFileLinkMeta("~/notes.md", "/Users/me/ws", "/Users/me/ws/docs"),
        { filePath: "/Users/me/notes.md" },
      ],
      [
        "file outside the workspace",
        resolveMarkdownFileLinkMeta("src/main.ts", "/ws", "/tmp/report"),
        { filePath: "/tmp/report/src/main.ts", workspaceRelativePath: null },
      ],
      [
        "heading in another file",
        resolveMarkdownFileLinkMeta("notes.md#part-two", "/ws", "/ws/docs"),
        { filePath: "/ws/docs/notes.md", heading: "part-two" },
      ],
      [
        "heading that starts like a line",
        resolveMarkdownFileLinkMeta("notes.md#l2-regularization", "/ws", "/ws/docs"),
        { filePath: "/ws/docs/notes.md", heading: "l2-regularization" },
      ],
      [
        "chat message",
        resolveInlineCodeFileLinkMeta("src/main.ts", "/ws"),
        { filePath: "/ws/src/main.ts", workspaceRelativePath: "src/main.ts" },
      ],
    ];
    for (const [label, meta, expected] of cases) {
      expect(meta, label).toMatchObject(expected);
    }
    expect(resolveMarkdownFileLinkMeta("https://example.com/a.md", "/ws", "/ws/docs")).toBeNull();
    expect(resolveMarkdownFileLinkMeta("notes.md#L3", "/ws", "/ws/docs")).not.toHaveProperty(
      "heading",
    );
  });

  it("search the workspace for a missed path only from chat", async () => {
    const search = async () => "src/discord/events/user.ts";
    const fromChat = resolveMarkdownFileLinkMeta("user.ts:261", "/ws");
    const fromDocument = resolveMarkdownFileLinkMeta("user.ts:261", "/ws", "/ws");
    if (!fromChat || !fromDocument) throw new Error("Expected file links");
    expect(fromChat.workspaceLookupPath).toBe("user.ts");
    expect(fromDocument.workspaceLookupPath).toBeNull();
    await expect(
      resolveMarkdownFileHostPath({
        meta: fromDocument,
        cwd: "/ws",
        findWorkspaceMatch: search,
        pathsExist: noPathsExist,
      }),
    ).resolves.toEqual({ absolutePath: "/ws/user.ts", matched: false });
  });
});

// Fork: docs write inline-code paths from the repository's top folder.
describe("inline code falls back to the workspace root", () => {
  const existing =
    (...found: string[]) =>
    async (paths: readonly string[]) =>
      paths.map((path) => found.includes(path));
  const inline = resolveInlineCodeFileLinkMeta("apps/web/src/App.tsx:12", "/ws", "/ws/fork");
  if (!inline) throw new Error("Expected a file link");

  it("opens beside the document, then from the root, then beside the document again", async () => {
    const cases: ReadonlyArray<[label: string, found: string[], expected: string]> = [
      [
        "own folder hit",
        ["/ws/fork/apps/web/src/App.tsx", "/ws/apps/web/src/App.tsx"],
        "/ws/fork/apps/web/src/App.tsx",
      ],
      ["root fallback", ["/ws/apps/web/src/App.tsx"], "/ws/apps/web/src/App.tsx"],
      ["neither found", [], "/ws/fork/apps/web/src/App.tsx"],
    ];
    for (const [label, found, expected] of cases) {
      await expect(pickMarkdownFilePath(inline, existing(...found)), label).resolves.toBe(expected);
    }
    await expect(pickMarkdownFilePath(inline, noPathsExist)).resolves.toBe(inline.filePath);
    const hostPath = await resolveMarkdownFileHostPath({
      meta: inline,
      cwd: "/ws",
      findWorkspaceMatch: async () => null,
      pathsExist: existing("/ws/apps/web/src/App.tsx"),
    });
    expect(markdownFileCopyPaths(inline, hostPath, "/ws")).toEqual({
      fullPath: "/ws/apps/web/src/App.tsx:12",
      relativePath: "apps/web/src/App.tsx:12",
    });
  });

  it("never applies to links, explicit relative paths, chat, or a document at the root", async () => {
    const link = resolveMarkdownFileLinkMeta("apps/web/src/App.tsx", "/ws", "/ws/fork");
    if (!link) throw new Error("Expected a file link");
    expect(link.rootFallbackPath).toBeNull();
    await expect(pickMarkdownFilePath(link, existing("/ws/apps/web/src/App.tsx"))).resolves.toBe(
      "/ws/fork/apps/web/src/App.tsx",
    );
    for (const [label, meta] of [
      ["./ path", resolveInlineCodeFileLinkMeta("./src/main.ts", "/ws", "/ws/docs")],
      ["../ path", resolveInlineCodeFileLinkMeta("../src/main.ts", "/ws", "/ws/docs/a")],
      ["chat", resolveInlineCodeFileLinkMeta("src/main.ts", "/ws")],
      ["root document", resolveInlineCodeFileLinkMeta("src/main.ts", "/ws", "/ws")],
      ["outside the workspace", resolveInlineCodeFileLinkMeta("src/main.ts", "/ws", "/tmp/r")],
    ] as const) {
      expect(meta?.rootFallbackPath, label).toBeNull();
    }
  });
});

describe("resolveInlineCodeFileLinkMeta", () => {
  it("links bare filenames only when a line suffix marks them as file references", () => {
    expect(resolveInlineCodeFileLinkMeta("script.ts:10", "/Users/julius/project")).toMatchObject({
      targetPath: "/Users/julius/project/script.ts:10",
      line: 10,
    });
    expect(resolveInlineCodeFileLinkMeta("AGENTS.md", "/Users/julius/project")).toBeNull();
  });

  it("opens a line range at its first line and keeps the range for the label", () => {
    expect(resolveInlineCodeFileLinkMeta("src/http.ts:42-64", "/repo")).toMatchObject({
      targetPath: "/repo/src/http.ts:42",
      line: 42,
      endLine: 64,
    });
  });

  it("does not treat arbitrary name:digits shapes as files", () => {
    expect(resolveInlineCodeFileLinkMeta("error:1", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("TODO:12", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("exit:0", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("port:3000", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("port:3000-3010", "/Users/julius/project")).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("localhost:3000-3010", "/Users/julius/project"),
    ).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("http:80", "/Users/julius/project")).toBeNull();
  });

  it("ignores hosts, ports, and versions", () => {
    expect(resolveInlineCodeFileLinkMeta("127.0.0.1:3000", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("localhost:3000", "/Users/julius/project")).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("example.com/index.html", "/Users/julius/project"),
    ).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("example.com:8080", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("10.0.0.1:80:1", "/Users/julius/project")).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("localhost/index.html", "/Users/julius/project"),
    ).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("example.uk/index.html", "/Users/julius/project"),
    ).toBeNull();
  });
});

describe("chat file chip paths", () => {
  const cwd = String.raw`C:\Users\alice\project`;

  it("opens and copies the indexed file for a bare filename, preserving its line and column", async () => {
    const meta = resolveMarkdownFileLinkMeta("user.ts:261:7", cwd);
    if (!meta) throw new Error("Expected a file link");
    const hostPath = await resolveMarkdownFileHostPath({
      meta,
      cwd,
      findWorkspaceMatch: async () => "src/discord/events/user.ts",
      pathsExist: noPathsExist,
    });

    expect(markdownFileEditorTarget(meta, hostPath)).toBe(
      String.raw`C:\Users\alice\project\src\discord\events\user.ts:261:7`,
    );
    expect(markdownFileCopyPaths(meta, hostPath, cwd)).toEqual({
      fullPath: String.raw`C:\Users\alice\project\src\discord\events\user.ts:261:7`,
      relativePath: "src/discord/events/user.ts:261:7",
    });
  });
});
