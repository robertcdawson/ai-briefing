---
title: GitHub Actions cron jitter made the daily episode look missing — schedule earlier + backup
date: 2026-07-28
category: docs/solutions/workflow-issues
module: daily GitHub Actions workflow
problem_type: workflow_issue
component: .github/workflows/daily.yml
severity: medium
applies_when:
  - A weekday episode is late or appears missing with no failed Actions run
  - Operators expect ~06:30 PT delivery but observe 08:00–09:30 PT
  - Tuning or defending the daily cron schedule
tags: [github-actions, cron, schedule, jitter, healthcheck, reliability]
---

# GitHub Actions cron jitter made the daily episode look missing — schedule earlier + backup

## Context

On 2026-07-28 the daily podcast looked missing at ~08:34 PT. There was **no failed pipeline** and **no queued run** yet — the Actions `schedule` event for `30 13 * * 1-5` simply had not been delivered. The run started at 15:40 UTC (~130 minutes past the cron minute) and completed successfully (~06 min), publishing `Episode 2026-07-28`.

July weekday history for this repo shows delays past the scheduled minute of roughly **45–184 minutes** (median ~116). The README previously documented a hard **06:30 PT** arrival from a 13:30 UTC cron, which only holds if GitHub fires near on time — it usually does not.

## Guidance

**Treat Actions cron as a best-effort trigger, not a clock.** Durable mitigations used here:

1. **Schedule earlier** than the desired local arrival (`17 11 * * 1-5`) so median ~2h jitter still lands near 06:30 PT.
2. **Add a late backup cron** (`47 14 * * 1-5`) for dropped primary runs.
3. **Skip paid stages when today's episode already exists** (`hasPublishedEpisode` in `src/publish.ts`, checked in `src/index.ts`) so the backup is cheap after a successful primary.
4. **Wire `HEALTHCHECK_URL`** into the daily workflow env so a dead-man's-switch catches true misses (unset = no-op).
5. **Avoid top-of-hour / :30 minutes** when picking cron minutes — GitHub documents higher load then.

Do **not** diagnose "no podcast" solely from wall-clock expectation without checking `gh run list --workflow=daily.yml` for an in-progress or not-yet-created schedule event.

## Example

Observed primary delays (scheduled `13:30` UTC) before the fix:

```
2026-07-27 15:56 UTC  (+147m)
2026-07-24 15:11 UTC  (+101m)
2026-07-06 16:33 UTC  (+184m)
```

After the fix, primary is `11:17` UTC; a +120m delay yields ~13:17 UTC (~06:17 PT PDT).

## Why this works

GitHub's scheduler queues `schedule` events globally and can delay or drop them under load. Moving the cron earlier absorbs the delay into the morning window listeners already tolerate; the backup cron covers drops; the on-disk skip guard prevents double LLM/TTS spend when both fire; healthchecks cover the case where neither fires.

## Consequences / trade-offs

- PST months still arrive one local hour earlier than PDT for the same UTC crons (unchanged seasonal trade-off).
- A backup that starts while the primary is still running waits on the `daily` concurrency group, then no-ops after checkout sees the published assets.
- Hard local-time guarantees still require an external scheduler calling `workflow_dispatch`.

## Related

- Feature: skip-if-published (`src/publish.ts` `hasPublishedEpisode`, `src/index.ts`).
- Monitoring: `src/healthcheck.ts`, `HEALTHCHECK_URL` in `.github/workflows/daily.yml`.
- Docs: README "Schedule drift".
