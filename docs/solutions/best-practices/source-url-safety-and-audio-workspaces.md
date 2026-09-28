---
title: Validate source links end-to-end and isolate TTS audio workspaces
date: 2026-09-28
category: docs/solutions/best-practices
module: sourceUrls / fetch / curate / publish / tts
problem_type: best_practice
component: src/sourceUrls.ts, src/fetch.ts, src/curate.ts, src/publish.ts, src/tts.ts, src/index.ts
severity: medium
applies_when:
  - Changing how show-note source links are built or escaped
  - Trusting curator or script sourceUrls from a stage-cache hit
  - Changing TTS temp directories, segment paths, or audio workspace cleanup
tags: [security, source-urls, rss, curation, publish, tts, tmp, stage-cache]
---

# Validate source links end-to-end and isolate TTS audio workspaces

## Context

Show-note `<a href>` values are assembled from RSS links and model-authored source lists. Those strings are untrusted even when they later load from a local stage cache. A second boundary is the TTS/audio temp tree: a predictable shared directory name let a pre-planted symlink redirect segment writes.

Two guards close those paths:

1. **Safe source URLs** — `isSafeSourceUrl` in `src/sourceUrls.ts`, applied at fetch, curate, and publish.
2. **Private TTS workspaces** — `mkdtemp` + mode `0700` in `src/tts.ts`, with failure cleanup before the caller learns the path.

## Guidance

### Source URLs

| Stage | Behavior |
|---|---|
| Fetch | Drop items whose `link` fails `isSafeSourceUrl` (silent skip). Trim kept URLs. |
| Curate | `resolveClusterSources` requires every cluster source to match a **safe fetched article URL** (exact trim match). Publisher comes from the article, not the model. |
| Pipeline after cache | `src/index.ts` runs `resolveClusterSources` again on the selected clusters so a stage-cache hit cannot replay invented URLs. |
| Script | `validateScriptResponse` / `reconcileScriptSourceUrls` keep segment `sourceUrls` aligned with the (already resolved) cluster list. |
| Publish | `buildSourceLinkParagraph` throws before any episode file is written if a URL is unsafe. |

`isSafeSourceUrl` rules (verify in `src/sourceUrls.ts` before changing callers):

- Reject control characters and backslashes **before** trim — `URL()` can strip some of them.
- Allow ordinary surrounding whitespace; reject internal spaces.
- Require absolute `http:` / `https:` with a non-empty hostname.
- Reject `javascript:`, `data:`, `file:`, protocol-relative, and path-only values.

Do **not** treat HTML attribute escaping in publish as a substitute for this check. Escaping prevents markup injection; the allow-list prevents non-HTTP schemes from becoming clickable show-note links.

### TTS workspaces

- Allocate with `mkdtemp(path.join(tmpdir(), "ai-briefing-"))` — never `ai-briefing-${date}-${pid}` or another guessable path.
- On synthesis failure, `synthesize` removes its own directory before rethrowing (the orchestrator only learns `segmentDir` on success).
- `src/index.ts` still best-effort `rm`s the workspace in `finally` after a successful run.
- Downstream `buildEpisodeAudio` writes into the same owned directory; do not reintroduce a second shared temp root for segments.

## Example

Unsafe links rejected at publish (and never written as partial assets):

```ts
isSafeSourceUrl("javascript:alert(1)") // false
isSafeSourceUrl("https://example.com/story") // true
isSafeSourceUrl(" https://example.com/story ") // true (trim OK)
isSafeSourceUrl("https://exa\nmple.com/story") // false (control before trim)
```

Cache-hit re-resolution (orchestrator):

```ts
const { selected, report } = await withStageCache("curate", { date, articles }, () =>
  curate(articles, date),
);
const clusters = selected.map((cluster) => resolveClusterSources(cluster, articles));
```

## Why this works

Each layer assumes the previous one can be bypassed (stale cache, hand-edited fixture, future caller). Fetch reduces junk; curate binds model output to the fetched set; publish is the last gate before executable HTML leaves the repo. Unique private temp dirs mean a symlink planted at an old predictable path cannot capture segment or ffmpeg writes.

## Related

- Code: `src/sourceUrls.ts`, `resolveClusterSources` in `src/curate.ts`, `buildSourceLinkParagraph` in `src/publish.ts`, `synthesize` in `src/tts.ts`.
- Tests: `test/sourceUrls.security.test.ts`, `test/tts.workspace.test.ts`.
- Glossary: `CONCEPTS.md` → Safe source URL, Audio workspace.
- Adjacent: fetch URL dedup (`docs/solutions/best-practices/fetch-url-deduplication-before-curation.md`) is about syndication overlap, not scheme safety.
- Adjacent: stage cache (`docs/solutions/best-practices/stage-cache-for-local-reruns.md`) — cache hits must still pass `resolveClusterSources`.
