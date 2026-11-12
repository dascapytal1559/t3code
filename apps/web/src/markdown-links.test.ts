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
  pickMarkdownFileCandidate,
  resolveMarkdownFileHostPath,
} from "./markdownFileHostPath";

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

  it("read beside the file first and keep the workspace-root reading as the fallback", () => {
    const cases: ReadonlyArray<
      [
        label: string,
        meta: ReturnType<typeof resolveMarkdownFileLinkMeta>,
        file: string,
        fallback: string | null,
      ]
    > = [
      [
        "inline code with a folder",
        resolveInlineCodeFileLinkMeta("scripts/run.md", "/ws", "/ws/data/demo"),
        "/ws/data/demo/scripts/run.md",
        "/ws/scripts/run.md",
      ],
      [
        "markdown link",
        resolveMarkdownFileLinkMeta("src/main.ts:4", "/ws", "/ws/docs"),
        "/ws/docs/src/main.ts",
        "/ws/src/main.ts",
      ],
      [
        "file outside the workspace",
        resolveMarkdownFileLinkMeta("src/main.ts", "/ws", "/tmp/report"),
        "/tmp/report/src/main.ts",
        "/ws/src/main.ts",
      ],
      [
        "file at the workspace root",
        resolveInlineCodeFileLinkMeta("src/main.ts", "/ws", "/ws"),
        "/ws/src/main.ts",
        null,
      ],
      [
        "explicit ./",
        resolveInlineCodeFileLinkMeta("./src/main.ts", "/ws", "/ws/docs"),
        "/ws/docs/./src/main.ts",
        null,
      ],
      [
        "explicit ../",
        resolveMarkdownFileLinkMeta("../b/notes.md", "/ws", "/ws/docs/a"),
        "/ws/docs/a/../b/notes.md",
        null,
      ],
      [
        "fallback that would leave the workspace",
        resolveMarkdownFileLinkMeta("a/../../x.md", "/ws", "/ws/docs"),
        "/ws/docs/a/../../x.md",
        null,
      ],
      [
        "absolute path",
        resolveMarkdownFileLinkMeta("/etc/hosts", "/ws", "/ws/docs"),
        "/etc/hosts",
        null,
      ],
      [
        "home path",
        resolveMarkdownFileLinkMeta("~/notes.md", "/Users/me/ws", "/Users/me/ws/docs"),
        "/Users/me/notes.md",
        null,
      ],
      [
        "chat message",
        resolveInlineCodeFileLinkMeta("src/main.ts", "/ws"),
        "/ws/src/main.ts",
        null,
      ],
    ];
    for (const [label, meta, filePath, fallbackFilePath] of cases) {
      expect(meta, label).toMatchObject({ filePath, fallbackFilePath });
    }
    expect(resolveMarkdownFileLinkMeta("https://example.com/a.md", "/ws", "/ws/docs")).toBeNull();
  });
});

describe("pickMarkdownFileCandidate", () => {
  const meta = resolveInlineCodeFileLinkMeta("scripts/run.md", "/ws", "/ws/data/demo");
  if (!meta) throw new Error("Expected a file link");
  const existing =
    (...found: string[]) =>
    async (paths: readonly string[]) =>
      paths.map((path) => found.includes(path));

  it("prefers the file beside the document, then the workspace root, else reports both", async () => {
    await expect(
      pickMarkdownFileCandidate(
        meta,
        existing("/ws/data/demo/scripts/run.md", "/ws/scripts/run.md"),
      ),
    ).resolves.toEqual({ filePath: "/ws/data/demo/scripts/run.md", alsoTried: null });
    await expect(pickMarkdownFileCandidate(meta, existing("/ws/scripts/run.md"))).resolves.toEqual({
      filePath: "/ws/scripts/run.md",
      alsoTried: null,
    });
    await expect(pickMarkdownFileCandidate(meta, existing())).resolves.toEqual({
      filePath: "/ws/data/demo/scripts/run.md",
      alsoTried: "/ws/scripts/run.md",
    });
  });

  it("opens editors and copies paths at the workspace-root reading when only it exists", async () => {
    const hostPath = await resolveMarkdownFileHostPath({
      meta,
      cwd: "/ws",
      findWorkspaceMatch: async () => null,
      pathsExist: existing("/ws/scripts/run.md"),
    });
    expect(markdownFileCopyPaths(meta, hostPath, "/ws")).toEqual({
      fullPath: "/ws/scripts/run.md",
      relativePath: "scripts/run.md",
    });
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
      pathsExist: async () => null,
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
