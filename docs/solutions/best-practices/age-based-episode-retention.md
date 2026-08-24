---
title: Keep feed membership and disk pruning on one age-based retention window
date: 2026-08-24
category: docs/solutions/best-practices
module: publish
problem_type: best_practice
component: src/publish.ts
severity: medium
applies_when:
  - Changing FEED_LIMIT, RETENTION_DAYS, or how feed.xml is rebuilt
  - Writing publish/feed unit tests that call writePodcastFeed / publish paths
  - Investigating why an episode older than ~14 days still appears in the feed or on disk
tags: [publish, retention, feed, prune, github-pages, selectFeedRecords]
---

# Keep feed membership and disk pruning on one age-based retention window

## Context

Feed membership used to be a plain **top-N-by-count** slice (`FEED_LIMIT`), while disk pruning used a separate **day window** (`RETENTION_DAYS`). At a weekday cadence those could diverge: an episode could stay in `feed.xml` (and therefore on disk, because the pruner never deletes a still-listed date) for longer than the intended “nothing older than N days” policy.

As of the 2026-08 retention fix, **`RETENTION_DAYS` (14) is the single source of truth** for both layers. `selectFeedRecords` keeps episode dates within that window of a shared `referenceDate`; `FEED_LIMIT` (14) is only a defensive count cap that rarely binds at ~10 weekday episodes per window.

## Guidance

| Concern | Rule |
|---|---|
| Feed membership | Age filter first (`date >= cutoff`), newest-first, then `slice(0, FEED_LIMIT)` |
| Disk prune | Delete episode asset families older than the same cutoff, **except** dates still in the feed keep-set |
| Shared clock | `writePodcastFeed` computes one `referenceDate` (UTC `YYYY-MM-DD`) and passes it to both select and prune so the two cannot disagree mid-run |
| Tuning | Change `RETENTION_DAYS` in `src/publish.ts`. Leave `FEED_LIMIT` alone unless publish cadence becomes multi-episode/day |

**Test gotcha:** any helper that rebuilds the real repo `docs/feed.xml` must pass `{ prune: false }`. With prune left on, a unit test would enforce `RETENTION_DAYS` against the committed `docs/episodes/` archive as a side effect. Existing coverage in `test/publish.apple-rss.test.ts` and `test/publish.soundbite-dollar.test.ts` already does this.

**Pages sizing:** episodes are ~16 MB; a full 14-day window stays well under GitHub Pages’ hard **1 GB** site limit. Widening retention without measuring site size reintroduces silent deploy-queue failures — see the publish-verification workflow note.

Boundary behavior pinned by tests: an episode whose date is **exactly** `referenceDate - RETENTION_DAYS` stays; one day older drops from the feed and becomes eligible for prune once it is also off the keep-set.

## Related

- Code: `src/publish.ts` (`RETENTION_DAYS`, `FEED_LIMIT`, `selectFeedRecords`, `resolveRetentionCutoff`, `pruneOldEpisodes`, `writePodcastFeed`)
- Tests: `test/publish.retention.test.ts`
- Operator docs: README **Retention**; `docs/solutions/workflow-issues/github-pages-publish-verification.md`
- Concepts: Retention, Already-published skip, Publish verification in `CONCEPTS.md`
