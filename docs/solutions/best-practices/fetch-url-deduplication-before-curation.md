---
title: Deduplicate RSS articles by canonical URL before paying for curation
date: 2026-07-29
category: docs/solutions/best-practices
module: fetch
problem_type: best_practice
component: src/fetch.ts
severity: low
applies_when:
  - Multiple feeds syndicate the same article URL (or tracking-param variants)
  - Curation token spend or cluster noise looks high relative to unique stories
  - Extending fetch-time article filtering
tags: [fetch, deduplication, rss, curation, cost, canonical-url]
---

# Deduplicate RSS articles by canonical URL before paying for curation

## Context

Several AI news feeds often carry the **same underlying link**, sometimes with click-id or UTM query variants (`fbclid`, `gclid`, `utm_*`, etc.). Without a fetch-time pass, those duplicates all enter `curate()`, which then spends LLM tokens to re-discover they are the same URL — or worse, treats tracking variants as separate items until clustering catches up.

`src/fetch.ts` now canonicalizes each article URL and keeps the **first** occurrence before returning the batch to the pipeline.

## Guidance

Treat fetch dedup and curation clustering as **two layers**:

| Layer | Key | Job |
|---|---|---|
| Fetch | Canonical URL (`canonicalArticleUrl`) | Drop identical / tracking-variant links across feeds |
| Curate | Story meaning (`canonicalKey` / clusters) | Merge *different* URLs that are the same story |

When changing fetch filtering:

1. Strip fragments; drop known tracking params; sort remaining query keys for stable keys.
2. Keep first-seen article order (deterministic across a single `fetchAll` run).
3. Log `rawArticles`, `duplicateArticles`, and `totalArticles` on the fetch summary line so operators can see how much syndication overlap there was.
4. Do **not** try to replace Story Cluster dedup with URL keys alone — different publishers use different URLs for the same event.

Malformed / non-URL strings fall back to the trimmed raw value so they still dedupe against exact duplicates without throwing.

## Example

```ts
// Same article, tracking variants → one Article after dedup
canonicalArticleUrl("https://ex.com/a?utm_source=x&id=1")
// → "https://ex.com/a?id=1"
canonicalArticleUrl("https://ex.com/a?fbclid=abc&id=1")
// → "https://ex.com/a?id=1"
```

Fetch summary log shape:

```json
{
  "phase": "fetch",
  "status": "ok",
  "rawArticles": 42,
  "duplicateArticles": 7,
  "totalArticles": 35
}
```

## Why this works

URL canonicalization is cheap, local, and deterministic. Removing known-duplicate links before the paid curate stage shrinks the prompt and reduces noise without changing how genuine multi-source stories are clustered.

## Related

- Code: `canonicalArticleUrl`, `deduplicateFetchedArticles` in `src/fetch.ts`.
- Tests: `test/fetch.deduplication.test.ts`.
- Glossary: `CONCEPTS.md` → URL canonicalization, Fetch deduplication, Specifics.
- Note: per-article excerpts are capped at **900** characters (raised from 500) so curation can extract verbatim Specifics for the script writer — see `src/fetch.ts` and `src/curate.ts`.
