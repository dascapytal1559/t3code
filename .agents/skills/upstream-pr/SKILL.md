---
name: upstream-pr
description: Prepare, test, and submit a PR from this fork (dascapytal1559/t3code) to upstream (pingdotgg/t3code), then babysit the bot and human feedback until resolution. Use when the user asks to PR something upstream, isolate work for upstream, polish an upstream PR, or address upstream PR feedback. Covers fork-commit exclusion, throwaway-worktree isolation, pre-create testing, PR-template compliance, screenshot hosting, and scheduling a feedback watcher.
---

# Upstream PR

Ship a change from this fork to `pingdotgg/t3code` without leaking fork-only
commits, with proof it works, in the shape upstream's maintainers ask for —
then watch the PR until every bot finding is resolved and a human has seen it.

## Know the topology first

- `upstream` = `pingdotgg/t3code` (push DISABLED — PRs only). `origin` = the
  `dascapytal1559/t3code` fork.
- Local `main` mirrors `upstream/main`. `mine` is the daily-driver branch:
  `main` + fork-only commits (desktop branding, personal patches). **Fork-only
  commits must never reach an upstream PR.**
- Feature work usually lives on a `claude/*` worktree branch cut from `mine`,
  so its history contains fork-only commits. Never PR that branch directly.

## Isolate the change

1. `git fetch upstream main` — always base on the fresh tip.
2. Build the PR branch in a throwaway worktree so running dev servers and the
   daily checkout are never disturbed:
   `git worktree add <scratch>/upstream-pr -b <branch-name> upstream/main`
3. Cherry-pick only the feature commits. Then audit for fork-only leakage:
   - Hunks depending on code that exists only in the fork (or only in another
     unmerged PR) must be dropped or the PR explicitly stacked. Prefer
     dropping: restore the file with `git checkout upstream/main -- <path>`
     and note in the body which provider/surface "lands with PR #X".
   - `pnpm-lock.yaml`: `vp i` annotates it with registry metadata noise.
     If the change adds no dependencies, evict it:
     `git checkout upstream/main -- pnpm-lock.yaml`.
4. Squash to ONE commit per concern (upstream: "one concern per PR", "if the
   description says 'also', split it"). Conventional title, plain language.
5. `vp i` in the throwaway worktree BEFORE committing — the pre-commit hook
   (vp fmt via lint-staged) needs node_modules and fails cryptically without.

## Test before creating (no repo-wide checks)

Run in the throwaway worktree, scoped to what changed:

- `vp run typecheck` in each touched package dir (`apps/server`, `apps/web`,
  …). Count `error TS` lines; `suggestion TS…` lines are pre-existing noise.
- `vp test run <touched test files>` — the suites for every file you changed,
  plus `apps/server/src/auth/RpcAuthorization.test.ts` whenever a WS method
  was added (it asserts scope-map completeness against the RpcGroup).
- `vp lint <touched files>`.
- Watch for the 20-argument `.pipe()` overload ceiling when adding layers to
  `apps/server/src/server.ts` or mocks to `server.test.ts` — fold new entries
  into an existing `Layer.mergeAll`/`.pipe` argument instead of appending.

## Create the PR

1. Re-read upstream's `CONTRIBUTING.md` and `.github/pull_request_template.md`
   before writing a word. Summary of their stance: not actively accepting
   contributions; small focused bug fixes are most likely to merge; feature
   work and large PRs are unwelcome; non-trivial changes want a discussion
   first. Frame genuine defect fixes as fixes, not features, and offer the
   discussion conversion in the body when the change is architecture-shaped.
2. Body follows the template sections: `## What Changed`, `## Why`,
   `## UI Changes`, `## Checklist`. End with the model/harness attribution
   line.
3. Anything resembling a UI change needs before/after images. Host them on an
   orphan `pr-assets-<topic>` branch in the fork and link
   `raw.githubusercontent.com/dascapytal1559/t3code/<branch>/<file>.png`.
   Capture honestly: dev server at the pre-change commit for "before", at the
   tip for "after" (headless Chrome + a fresh pairing token works; drafts are
   per-client, so scripts must select the provider themselves).
4. `git push -u origin <branch-name>` then
   `gh pr create --repo pingdotgg/t3code --base main --head dascapytal1559:<branch-name> …`
5. Labels are automatic (`vouch:unvouched`, `size:*`) — not actionable.

## Watch and address feedback

Bots respond within ~2–15 minutes of every push; a human may take days.
**Schedule a watcher instead of assuming a one-shot check is enough**: use the
harness's recurring facility (`/loop` with a self-paced or ~15m interval, a
scheduled wakeup, or a cron'd session) running the babysit pass below until
the bots are green on the latest commit, then stretch the cadence for the
human-review wait. A closed PR can be reopened (`gh pr reopen`) as long as its
head branch was never force-pushed — so feedback on a withdrawn PR is still
worth harvesting and fixing.

Each babysit pass:

1. `gh pr checks <n> --repo pingdotgg/t3code` and
   `gh api repos/pingdotgg/t3code/pulls/<n>/comments` /
   `…/issues/<n>/comments` — only items newer than the last push matter.
2. Known bots and how to read them:
   - **Cursor Bugbot** — inline findings with severity. Check the footer's
     commit SHA: a comment "for commit <old-sha>" is a stale repost, not a
     new finding. Its hit rate here has been high (real bugs found: skills
     marked enabled despite `userInvocable: false`; probe timeouts wiping a
     cache via success-with-empty). Verify against source anyway.
   - **Macroscope** — correctness + approvability verdicts and inline
     conventions feedback. "Needs human review" on feature-shaped PRs is
     policy, not a defect. Convention suggestions: check the nearest sibling
     module before accepting; decline with a reason when the codebase
     precedent contradicts the bot.
   - **CodeRabbit** — auto-review disabled repo-wide; its "Review skipped"
     comment is noise.
   - **Vercel – t3code-marketing** — always fails for external forks
     ("Authorization required"); ignore.
3. Verify every finding against the source. Fix real ones (commit to the PR
   branch — normal push, never force), dismiss false positives with a written
   reason. Mirror real fixes back to the fork branch / `mine` so the fork
   never ships the bug the bot caught.
4. Stop the watcher when bots are green on the latest commit and the human
   decision (merge/close/discussion) has landed. Stay quiet when nothing new.
