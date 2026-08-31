---
title: Dependabot PRs enable auto-merge via pull_request_target
date: 2026-08-31
category: docs/solutions/workflow-issues
module: dependabot-auto-merge GitHub Actions workflow
problem_type: workflow_issue
component: .github/workflows/dependabot-auto-merge.yml
severity: low
applies_when:
  - Dependabot opens a version bump and it never merges
  - Changing required checks, branch protection, or allowed merge methods
  - Debugging why `gh pr merge --auto` appears to succeed but the PR stays open
tags: [github-actions, dependabot, auto-merge, pull_request_target, ci]
---

# Dependabot PRs enable auto-merge via pull_request_target

## Context

Dependency bumps used to sit open until someone clicked merge. As of commit `f42de7a`, `.github/workflows/dependabot-auto-merge.yml` enables GitHub **auto-merge (squash)** for every PR authored by `dependabot[bot]`.

The workflow is intentionally tiny:

1. Trigger: `pull_request_target` (runs in the **base** branch context so `GITHUB_TOKEN` can write to the PR).
2. Guard: job `if` requires `github.event.pull_request.user.login == 'dependabot[bot]'`.
3. Action: `gh pr merge --auto --squash "$PR_URL"` with `contents: write` + `pull-requests: write`.

It does **not** approve the PR, skip required checks, or force-merge. Auto-merge only completes after the repository's usual merge gates pass.

## Guidance

| Concern | Rule |
|---|---|
| Who gets auto-merge | Only `dependabot[bot]`. Human / other-bot PRs are ignored by the job `if`. |
| Merge method | Squash only (`--squash`). Repo settings must allow squash merges. |
| Repo prerequisite | **Settings → General → Allow auto-merge** must be on, or `gh pr merge --auto` no-ops / errors. |
| Branch protection | Required status checks still apply. If reviews are required and Dependabot has no approving review, the PR stays queued until a human approves (or you add a separate approve workflow — this repo does not). |
| Security posture | `pull_request_target` is scoped to enabling merge metadata; the job never checks out the PR head or runs Dependabot-supplied code. Keep it that way. |

**Do not** broaden the `if` to all PRs, switch to `pull_request` without thinking through token permissions, or add a checkout+install of the PR branch in this workflow.

## Example

After Dependabot opens a PR, the workflow run should show a single step that enabled auto-merge. Confirm with:

```bash
gh pr view <number> --json autoMergeRequest,mergeStateStatus,statusCheckRollup
```

`autoMergeRequest` non-null means the queue is armed; `mergeStateStatus` / checks tell you why it has not landed yet (failing CI, required review, dirty base, etc.).

## Related

- Workflow: `.github/workflows/dependabot-auto-merge.yml`
- Sibling ops docs: `docs/solutions/workflow-issues/github-actions-cron-jitter-and-backup-schedule.md`, `docs/solutions/workflow-issues/updating-feature-branches-merge-not-rebase.md`
- Operator overview: README **Dependency updates (Dependabot)**
