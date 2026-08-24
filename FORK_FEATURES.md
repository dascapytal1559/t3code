# Fork features

Synced on 2026-08-24 against upstream `643daa516`; the pre-sync fork is preserved at `backup/upstream-test-drive-pre-sync-20260824` (`99af16a46`).

## Additions

- Fork identity — brands fork desktop builds distinctly so users can tell them apart from upstream releases.
- Grok skill discovery — asks `grok inspect --json` for Grok's effective user-invocable skill inventory.
- Workspace-aware skills — resolves the selected provider instance's skills for the active project instead of reusing one server-wide snapshot.
- Symlink-aware explorer — supplements the native workspace index with files and directories reachable through symlinked directories.
- Hidden-root visibility — includes dotfiles and dot-directories that the native workspace index omits from explorer and path search results.
- Live filesystem updates — watches opened workspaces and invalidates web file-explorer queries after external filesystem changes.

## Upstream comparison

| Fork addition           | Upstream status                                                                                                                                                                         | Value verdict                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Fork identity           | Not applicable upstream; upstream naturally retains its own branding.                                                                                                                   | Keep for fork distributions.                                                                                                      |
| Grok skill discovery    | Not addressed: upstream's Grok provider still publishes no skills.                                                                                                                      | Keep; it remains unique and useful.                                                                                               |
| Workspace-aware skills  | Partial overlap: upstream redesigned `$`, added skills to `/`, and labels skill sources, but Codex skills still come from one provider-probe CWD and there is no per-project skill RPC. | Keep the discovery model, but feed its result into both `$` and `/` on web and mobile.                                            |
| Symlink-aware explorer  | Not addressed in upstream's indexed file explorer or path search.                                                                                                                       | Kept, with VCS-ignore filtering and workspace-boundary enforcement added during the sync.                                         |
| Hidden-root visibility  | Partially addressed only by upstream's direct filesystem browse path; the indexed explorer and path search still omit these entries.                                                    | Kept, with gitignored hidden trees filtered before results are merged.                                                            |
| Live filesystem updates | Not addressed: upstream exposes no workspace-watch subscription.                                                                                                                        | Kept as one feature; watcher-safe bundling remains its implementation detail, and invalidation now covers path search and mobile. |

## Assessment

Upstream validates the product value of better skill discovery by investing in the `$` and `/` interfaces, but it has not replaced the fork's project-aware or Grok-aware discovery. The strongest result is therefore upstream's newer presentation with the fork's contextual inventory behind it.

The sync keeps the differentiated explorer behavior while closing its integration gaps: supplemental results respect VCS ignores and workspace boundaries, invalid paths no longer leak raw `realpath` failures through RPC, search starts watching its workspace, and both web and mobile refresh affected queries. Watcher-safe server bundling stays coupled to live updates rather than being presented as a separate feature.
