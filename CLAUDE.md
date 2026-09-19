# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A fully-automated weekday AI news podcast ("AI Briefing"). GitHub Actions cron runs the whole pipeline each weekday morning; there is no web server and no database — state lives in `docs/episodes/*.json` sidecars plus git. GitHub Pages serves `docs/` as the podcast feed.

## Commands

```bash
npm run build          # tsc --noEmit — the ONLY static check (no ESLint/Prettier configured)
npm run test:unit      # unit tests, no API keys needed
npm test               # smoke test — hits live RSS feeds (~10-35s), no keys needed
npm run preflight      # fail-fast env + ffmpeg/ffprobe checks, no provider calls
npm start              # full paid pipeline; skips if today's episode already exists on disk
npm run style:report   # prose metrics across recent transcripts (local files only)
```

Run a single test: `npx tsx --test test/<name>.test.ts` (tests use `node:test`; the exception is `test/publish.apple-rss.test.ts`, which is run directly as `npx tsx test/publish.apple-rss.test.ts`).

Local runs need Node 20+ and `ffmpeg`/`ffprobe` on PATH. `npm start` needs a `.env` (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `FEED_BASE_URL`, …) — the full env var reference is in `AGENTS.md` and `README.md`.

## Architecture

The pipeline is a linear sequence of stages orchestrated by `src/index.ts`:

```
already-published skip → preflight → fetch → curate → script → earEdit → tts → audio → publish → verifyDeploy
```

- **fetch** (`src/fetch.ts`): aggregates curated RSS feeds (`src/feeds.ts`), canonicalizes URLs (strips tracking params) and drops duplicate URLs *before* curation, so the LLM never scores the same link twice.
- **curate** (`src/curate.ts`): LLM (Claude via OpenRouter) clusters articles into Story Clusters, scores Importance (0–100), and selects what airs. Reads the **Curation Ledger** (`src/ledger.ts`) — a rolling ~14-day window of prior coverage built from episode sidecars — to *suppress* already-covered stories or thread them as *Follow-ups*, including carrying forward the host's prior `stance` on a story. `canonicalKey` (kebab-case story slug) is the join key across days.
- **script** (`src/script.ts`): writes a single-host spoken script. A large anti-repetition system keeps prose fresh: style snippets from recent transcripts injected as do-not-reuse blocks, date-hashed daily intro/outro/segment-shape "moves", a statistical phrase tripwire (`src/ngrams.ts`), and hard outro-mold regex validators that reject an attempt so the model re-rolls (3 attempts per model, with model fallbacks). The persistent host identity lives in `src/voice.ts`.
- **earEdit** (`src/earEdit.ts`): non-blocking LLM copy-edit pass; any failure falls through to the unedited script.
- **tts** (`src/tts.ts`, `src/ttsProvider.ts`): one TTS request per intro/story/outro part for continuous prosody, chunked fallback for oversized parts. Provider is OpenAI (default) or OpenRouter.
- **audio** (`src/audio.ts`): ffmpeg via `execa` — section stingers, concat, EBU R128 loudness normalization, MP3 + ID3 + embedded chapters.
- **publish** (`src/publish.ts`): writes `docs/episodes/YYYY-MM-DD.{mp3,json,chapters.json,transcript.txt}`, regenerates `docs/feed.xml`, prunes episodes past the 14-day retention window.
- **verifyDeploy** (`src/verifyDeploy.ts`): polls the live Pages feed for today's GUID — a successful commit/push does not mean listeners can fetch the episode.

**Stage caching** (`src/stageCache.ts`): with `STAGE_CACHE_DIR` set (local dev only), curate/script/earEdit outputs are cached by a content hash of their inputs, so re-running after a later-stage failure doesn't re-pay for LLM calls.

**Cross-episode memory is file-based**: everything the pipeline "remembers" (prior coverage, stances, recent prose style) is derived from the sidecar JSONs and transcripts in `docs/episodes/` — there is no other state.

## Key references

- `CONCEPTS.md` — domain vocabulary (Story Cluster, canonicalKey, Suppression, Follow-up, Stance memory, etc.). Use these terms; check it when orienting.
- `AGENTS.md` — full command/env-var tables and runtime notes.
- `docs/solutions/` — documented fixes and operational patterns with YAML frontmatter, organized by category. Check for relevant docs before implementing or debugging in a documented area.

## Gotchas

- `npm start` writes to `docs/episodes/` and regenerates `docs/feed.xml` — do not commit these changes in dev unless intentional.
- Already-published skip: if today's sidecar JSON and MP3 both exist, `npm start` exits before paid stages. Delete both locally only to intentionally regenerate.
- `BANNED_SCRIPT_PHRASES` in `src/script.ts` is frozen (the comment says so) — new AI-sounding tics are handled by the phrase tripwire, not by adding entries.
- Fetch dedup (identical/tracking-variant URLs) and curate clustering (different URLs, same story) are distinct layers — don't collapse them.
- Feature branches are updated by merging main, not rebasing (`docs/solutions/workflow-issues/updating-feature-branches-merge-not-rebase.md`).
