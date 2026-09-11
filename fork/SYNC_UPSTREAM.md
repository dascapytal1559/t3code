# Sync upstream

Runbook for merging upstream T3 Code into the fork: reassess every
`fork/README.md` entry against the new upstream, drop deltas that are no
longer needed, and land the merge. Applies whenever the user asks to sync
from upstream, merge upstream/main, or reassess fork features after an
upstream release.

The forked repo is `~/Projects/t3code-fork`. Drive git with
`git -C ~/Projects/t3code-fork` — worktree branches cannot move the
daily-driver checkout. Remotes: `origin` is the fork backup,
`upstream` is `pingdotgg/t3code` (push disabled).

`fork/README.md` is the canonical list of what this fork still
adds. A sync that leaves a dead entry in it, or a live delta that is not
in it, is unfinished.

Do not deploy. Deploy is `fork/DEPLOY_FORK.md` and runs only on
an explicit instruction.

## Stance — argue for upstream

The default is to delete fork code. Every sync is a chance to shrink
the fork, not to rebase our patches forward out of habit.

For each `##` heading in `fork/README.md` except **Sync status**, argue
**for upstream** against the entry:

1. Did upstream ship the same user-visible behavior (even by a different
   mechanism)? Drop the fork implementation and the entry.
2. Is the fork a parallel path that can move onto upstream's new API?
   Adapt, then drop the leftover.
3. Does the documented product still fail on stock upstream? Keep, and
   say why in the merge notes. "Different" is not a reason. "Broken
   without us" is.
4. If you are not sure it is still load-bearing, test stock upstream
   behavior empirically (the real provider CLI or the new upstream
   code path — not the fork). If upstream does not block the user's
   action, treat it as correct and drop the fork delta. A guarantee
   the CLI itself must provide (not "the model usually notices") is
   the only empirical result that keeps a send-path rewrite.

Report a keep/drop table before landing. If a drop is a product call
the user might refuse, say so — then still default to drop when
upstream is not broken.

## 1. Read the ledger

Read `fork/README.md`. The **Sync status** section names the last
upstream sha and the pre-sync backup branch. Collect every
`Implementation:` and `Tests:` path — those are the files that must be
audited even when git reports a clean auto-merge.

Working tree must be clean. Daily-driver branch is
`git -C ~/Projects/t3code-fork branch --show-current`.

## 2. Fetch and measure

```bash
git -C ~/Projects/t3code-fork fetch upstream
git -C ~/Projects/t3code-fork fetch origin
git -C ~/Projects/t3code-fork rev-parse --short HEAD upstream/main
git -C ~/Projects/t3code-fork merge-base HEAD upstream/main
git -C ~/Projects/t3code-fork log --oneline <last-sync-sha>..upstream/main
```

If `merge-base` is not the last recorded sync sha, stop and tell the
user — the histories have diverged in a way this runbook does not
cover.

Map upstream commits onto the implementation paths from step 1. Those
overlaps are the conflict surface, including files that will
auto-merge.

## 3. Backup

```bash
git -C ~/Projects/t3code-fork branch backup/upstream-test-drive-pre-sync-YYYYMMDD HEAD
```

Use today's date. Do not reuse an existing backup name.

## 4. Merge

Merge, do not rebase. The fork's history and backup SHAs are merge-based.

```bash
git -C ~/Projects/t3code-fork merge --no-ff --no-commit upstream/main
```

## 5. Resolve conflicts

Unresolved markers are the easy part. Keep fork-only files and the
behavior `fork/README.md` still claims. When upstream independently
implemented the same product, take upstream's mechanism even if it is
not the fork's old patch — then go to step 7 and retire the entry.

Record each resolution in the merge commit body. Previous merges named
the files and the choice (adopt upstream X, keep fork Y, adapt Z onto
upstream's new hook).

Migration ids: the fork owns `050_ProjectionProjectsVcsRoot`, and the
live databases (daily driver and remote hosts) have recorded id 50 under
that name. The Effect migrator skips every id at or below the highest
applied one, so upstream migrations numbered 50 and above are renumbered
one higher on merge: rename the file and its test, and shift the test's
`toMigrationInclusive` values and the `Migrations.ts` entry. Do not
renumber the fork's migration and do not edit live migration tables.

## 6. Audit auto-merged overlapping files

A clean merge is not a correct merge. For every implementation path
upstream also touched, read the result.

The failure class: both implementations survive and defeat each other.
A fork send-path rewrite that mutates tokens an upstream dispatcher
still needs to see is a merge bug, not a feature. Delete one path —
usually the fork's.

## 7. Reassess (mandatory)

Walk every feature heading. Produce the keep/drop table. Delete retired
fork code in this sync, not "later". Tests and comments that exist only
to defend the retired delta go with it: the entry's `.fork.test.ts`
files and its `fork:`-prefixed tests in upstream harness files.

## 8. Tests

`vp test run` the files you touched, then run the fork suite:

```bash
cd ~/Projects/t3code-fork && vp run test:fork
```

That is every `*.fork.test.ts` file plus the `fork: `-prefixed tests
inside `server.test.ts` and `ClaudeAdapter.test.ts` (the **Reality
check** section of `fork/README.md`). Red means the merge is not
finished: either the fork code regressed, or the entry should have been
retired in step 7 and its tests deleted with it. No repo-wide `vp check`.

## 9. Update `fork/README.md`

- Remove retired entries in the same landing as the code removal.
- Update remaining entries only when their behavior or implementation
  path changed.
- **Sync status**: date, upstream sha, backup branch and its sha, one
  sentence of what this sync did to the _fork_ (adopted, dropped,
  adapted). Not an upstream changelog. Do not claim a delta you then
  deleted in a follow-up commit.

## 10. Land

```
merge: upstream/main <version> into fork

Conflict resolutions:
- …

Reassessed:
- dropped … (now upstream / not broken)
- kept … (still fails on stock upstream because …)

Pre-sync fork: backup/upstream-test-drive-pre-sync-YYYYMMDD (<sha>).
```

Push `origin` of the daily-driver branch. Stop. Deploy only if the
user's current message asked for it.
