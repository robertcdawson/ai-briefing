---
title: Update feature branches with merge, not rebase (force-push and reset --hard are guarded)
date: 2026-06-17
category: docs/solutions/workflow-issues
module: development workflow (git)
problem_type: workflow_issue
component: development_workflow
severity: low
applies_when:
  - Bringing a feature branch up to date after main advanced (e.g. a sibling PR merged)
  - Resolving conflicts across several parallel feature branches before merging them one by one
tags: [git, rebase, merge, force-push, conflicts, branches]
---

# Update feature branches with merge, not rebase (force-push and reset --hard are guarded)

## Context

When several feature branches are open at once and `main` moves (a sibling PR merges), each branch needs to absorb the new `main` before it can merge cleanly. The instinct is to `git rebase main` and `git push --force-with-lease`. In this environment that's a dead end: a safety guard blocks both `git push --force*` **and** `git reset --hard`, so after a rebase the rewritten history can't be pushed and the rebase can't be cleanly undone.

A second, repo-specific friction compounds it: parallel branches tend to edit the **same single lines** — the one-line `test:unit` script in `package.json`, the orchestrator's `main()` loop in `src/index.ts`, and the env-var list in `AGENTS.md`. Each branch appends its own entry to those exact lines, so every branch conflicts with every other on them, and merging one branch dirties all the others.

## Guidance

**Bring `main` into the branch with `git merge`, not `git rebase`.** A merge adds a merge commit on top of the existing history, so a normal `git push` (fast-forward of the remote branch) works — no force-push, no guard trip:

```
git checkout main && git pull --ff-only
git checkout <feature-branch>
git merge main --no-edit       # resolve conflicts, then it commits
npm run build && npm run test:unit
git push                        # normal push; no --force needed
```

**Expect, and batch-resolve, the shared-line conflicts.** On these "registry" lines the resolution is always *keep every addition*:
- `package.json` `test:unit` — include every test file from both sides.
- `src/index.ts` `main()` — keep all the added steps/imports from both sides (they sit in different regions and usually auto-merge; the import block is the common manual one).
- `AGENTS.md` env list — keep both new env-var bullets.

**Merge sequencing matters.** Because the branches share those lines, "all clean against current `main`" does **not** mean mutually clean. Merge one branch to `main`, then re-merge the new `main` into the next branch (it will conflict again on the shared line) before merging it. Do them one at a time, refreshing each remaining branch after the previous merges.

## Why This Matters

The rebase + force-push reflex wastes a full cycle here (rebase succeeds, push is blocked, and you can't `reset --hard` back), and it's not obvious until you hit the guard. Merging is the path that actually works within the guardrails, and naming the three conflict-magnet lines up front turns a surprising sequence of conflicts into a mechanical "keep both."

## When to Apply

- Any time a feature branch must absorb a moved `main` and you'd normally reach for rebase.
- When coordinating several open PRs that touch the shared single-line registries above.

## Examples

The conflict on `package.json` always looks like two versions of the same `test:unit` line, each missing the other's newly added `test/*.test.ts`; the resolution is the union of both lists. The `AGENTS.md` conflict is two env-var bullets added after the same line; keep both.

## Related

- A durable fix for the biggest conflict magnet: make `test:unit` glob the test directory (e.g. run `tsx --test test/*.test.ts`) instead of listing every file by hand, so adding a test no longer edits a shared line. Worth doing if branch conflicts on that line keep recurring.
