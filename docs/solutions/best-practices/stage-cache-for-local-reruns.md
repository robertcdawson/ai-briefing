---
title: Cache curate/script/earEdit locally so late-stage re-runs do not re-pay for LLMs
date: 2026-09-14
category: docs/solutions/best-practices
module: stageCache
problem_type: best_practice
component: src/stageCache.ts, src/index.ts
severity: medium
applies_when:
  - Re-running npm start locally after TTS, audio, or publish failed
  - Debugging why a local re-run still hit OpenRouter for curate/script
  - Changing style snippets, phrase profiles, or ear-edit inputs and expecting a fresh LLM call
  - Considering actions/cache for CI (out of scope today)
tags: [stage-cache, local-dev, cost, curate, script, earEdit, pipeline]
---

# Cache curate/script/earEdit locally so late-stage re-runs do not re-pay for LLMs

## Context

The daily pipeline is fetch → curate → script → (earEdit) → TTS → audio → publish. When a **late** stage fails (TTS quota, ffmpeg, git push race), a naïve local re-run re-pays for curation and script. `src/stageCache.ts` is an opt-in, content-hashed cache so you can reproduce the same episode you were about to publish without re-rolling the expensive stages.

## How it works

Enabled only when `STAGE_CACHE_DIR` is set (for example `tmp/stage-cache`). Unset = fully disabled; CI runners never set it, so production behavior stays byte-identical.

`withStageCache(stage, input, compute)` in `src/index.ts` wraps three stages:

| Stage | Cache input (hashed) | Why those fields |
|---|---|---|
| `curate` | `{ date, articles }` | Same fetch payload → same curation |
| `script` | `{ date, clusters, recentStyle, phraseProfile }` | Style snippets + phrase tripwire must invalidate when anti-repetition examples change |
| `earEdit` | `{ date, episode: { intro, segments, outro }, notes }` | Script text + per-cluster headline / whyItMatters / caveat notes |

Keying details (`cacheKey` in `src/stageCache.ts`):

1. SHA-256 of `stage + ":" + JSON.stringify(input)`, truncated to 32 hex chars.
2. File path: `$STAGE_CACHE_DIR/${stage}-${key}.json`.
3. On hit: log `{ phase: "stage-cache", status: "hit" }` and return `JSON.parse`.
4. On miss: run `compute`, then best-effort write (`status: "store"`).
5. Corrupt / unreadable cache files and write failures are **non-fatal** — the stage computes normally and logs a warn on write failure.

## Guidance

**Do**

1. Set `STAGE_CACHE_DIR=tmp/stage-cache` (or similar) in local `.env` when iterating after a late-stage failure.
2. Keep `recentStyle` / `phraseProfile` inside the script cache key (already wired) so prompt A/B against new transcripts does not silently reuse yesterday's script.
3. Treat ear-edit cache hits as returning a fresh object — `src/index.ts` logs `edited` / `edits` from the cached payload rather than comparing object identity.
4. Delete the cache directory (or the specific `stage-*.json` files) when you intentionally want a new LLM roll with unchanged inputs.

**Do not**

- Expect this to help GitHub Actions. Runners are ephemeral; wiring `actions/cache` would be a separate CI change.
- Cache TTS/audio/publish. Those stages are not wrapped; only LLM stages are.
- Rely on cache writes for correctness. A full disk or permission error must never fail the pipeline.

## Example

```bash
# .env (local only)
STAGE_CACHE_DIR=tmp/stage-cache

# First run: stores curate/script/earEdit after each stage
npm start
# … TTS or publish fails …

# Second run with the same inputs: logs stage-cache hit and skips OpenRouter for those stages
npm start

# Force a fresh script with identical clusters:
rm tmp/stage-cache/script-*.json
npm start
```

## Related

- Code: `src/stageCache.ts`, call sites in `src/index.ts`
- Tests: `test/stageCache.test.ts`
- Ops: README → Manual operations → Local stage cache
- Glossary: Stage cache in `CONCEPTS.md`
- Sibling: `docs/solutions/best-practices/script-anti-repetition-style-memory.md` (why style snippets belong in the script key)
