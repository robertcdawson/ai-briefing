---
title: A git push is not a publish — verify the live Pages feed
date: 2026-08-10
category: docs/solutions/workflow-issues
module: verifyDeploy
problem_type: workflow_issue
component: src/verifyDeploy.ts
severity: high
applies_when:
  - An episode commit is green but Apple Podcasts / the public feed lack the day
  - Changing the daily workflow commit, deploy, or healthcheck steps
  - Tuning FEED_LIMIT / RETENTION_DAYS near the GitHub Pages 1 GB site limit
tags: [github-pages, publish, verify-deploy, healthcheck, retention, cron]
---

# A git push is not a publish — verify the live Pages feed

## Context

On 2026-08-06 the pipeline generated, committed, and pushed the episode cleanly, but the **GitHub Pages deploy** sat in `deployment_queued` until the action timed out and cancelled it. Listeners never saw the episode. Every pipeline step was green and the healthcheck reported success.

Two follow-on traps made recovery worse:

1. **Already-published skip** — the backup cron saw sidecar + MP3 on disk, exited before any republish, and pinged success.
2. **Site size** — a long retention window (~70 episodes / ~780 MB toward the hard **1 GB** Pages limit) increases the chance of silent deploy failure. Feed listing and disk retention are now a single age-based window: **14 days** (~150–225 MB), with `FEED_LIMIT` (14) as a defensive count cap that rarely binds.

## Guidance

The `Verify published feed` step in `.github/workflows/daily.yml` asks the only listener-facing question: **is today's GUID in the public feed?**

1. Poll `$FEED_BASE_URL/feed.xml` (cache-busted) for `<guid>ai-briefing-YYYY-MM-DD</guid>` (up to ~8 minutes on the first probe).
2. If missing, push an **empty commit** to start a *new* Pages deployment (re-running the failed deploy queues behind the same stuck job).
3. Poll again (up to ~10 minutes). Still missing → `HEALTHCHECK_URL/fail` and fail the run.

The step runs **even when generation was skipped**, so the backup cron becomes a recovery path for stuck deploys.

Local / manual:

```bash
FEED_BASE_URL=https://<user>.github.io/ai-briefing npx tsx scripts/verify-deploy.ts
# First probe in CI uses --quiet so a soon-to-be-fixed miss does not page.
VERIFY_TIMEOUT_MS=480000 npx tsx scripts/verify-deploy.ts --quiet
```

When changing retention, edit `RETENTION_DAYS` in `src/publish.ts` — it now governs both feed membership (`selectFeedRecords`) and disk pruning (`pruneOldEpisodes`) directly. `FEED_LIMIT` is a separate defensive count cap. `test/publish.retention.test.ts` pins the window and exercises `selectFeedRecords`.

## Related

- Code: `src/verifyDeploy.ts`, `scripts/verify-deploy.ts`, `.github/workflows/daily.yml`
- Tests: `test/verifyDeploy.test.ts`, `test/publish.retention.test.ts`
- Operator docs: README sections **Publish verification** and **Retention**
- Concepts: Publish verification, Already-published skip in `CONCEPTS.md`
