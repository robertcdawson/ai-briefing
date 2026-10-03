# AGENTS.md

Shared agent instructions for this repo. `CLAUDE.md` only imports this file so Claude Code and Cursor read one body.

## Overview

**ai-briefing** ("AI Briefing") is a fully automated weekday AI news podcast pipeline. GitHub Actions cron runs it each weekday morning. It fetches RSS feeds, curates stories via LLM, generates a spoken script, synthesizes audio via TTS, and publishes an RSS podcast feed. There is no web server and no database — state lives in `docs/episodes/*.json` sidecars plus git. GitHub Pages serves `docs/` as the podcast feed.

## Architecture

The pipeline is a linear sequence of stages orchestrated by `src/index.ts`:

```
already-published skip → preflight → fetch → curate → script → earEdit → tts → audio → publish → verifyDeploy
```

- **fetch** (`src/fetch.ts`): aggregates curated RSS feeds (`src/feeds.ts`), canonicalizes URLs (strips tracking params) and drops duplicate URLs *before* curation, so the LLM never scores the same link twice.
- **curate** (`src/curate.ts`): LLM (Claude via OpenRouter) clusters articles into Story Clusters, scores Importance (0–100), and selects what airs. Reads the **Curation Ledger** (`src/ledger.ts`) — a rolling ~14-day window of prior coverage built from episode sidecars — to *suppress* already-covered stories or thread them as *Follow-ups*, including carrying forward the host's prior `stance` on a story. `canonicalKey` (kebab-case story slug) is the join key across days.
- **script** (`src/script.ts`): writes a single-host spoken script. A large anti-repetition system keeps prose fresh: style snippets from recent transcripts injected as do-not-reuse blocks, date-hashed daily intro/outro/segment-shape "moves", a statistical phrase tripwire (`src/ngrams.ts`), and hard outro-mold regex validators that reject an attempt so the model re-rolls (3 attempts per model, with model fallbacks). The persistent host identity lives in `src/voice.ts`, overridden in production by `config/show.json` (edited from the tune page at `docs/tune/`).
- **earEdit** (`src/earEdit.ts`): non-blocking LLM copy-edit pass; any failure falls through to the unedited script.
- **tts** (`src/tts.ts`, `src/ttsProvider.ts`, `src/geminiTts.ts`): one TTS request per intro/story/outro part for continuous prosody, chunked fallback for oversized parts. Provider is OpenAI (default), OpenRouter, or Gemini (`gemini-3.8-flash-tts`) when the show voice is a designed `voice_…` id.
- **audio** (`src/audio.ts`): ffmpeg via `execa` — section stingers, concat, EBU R128 loudness normalization, MP3 + ID3 + embedded chapters.
- **publish** (`src/publish.ts`): writes `docs/episodes/YYYY-MM-DD.{mp3,json,chapters.json,transcript.txt}`, regenerates `docs/feed.xml`, prunes episodes past the 14-day retention window.
- **verifyDeploy** (`src/verifyDeploy.ts`): polls the live Pages feed for today's GUID — a successful commit/push does not mean listeners can fetch the episode.

**Stage caching** (`src/stageCache.ts`): with `STAGE_CACHE_DIR` set (local dev only), curate/script/earEdit outputs are cached by a content hash of their inputs, so re-running after a later-stage failure doesn't re-pay for LLM calls.

**Cross-episode memory is file-based**: everything the pipeline "remembers" (prior coverage, stances, recent prose style) is derived from the sidecar JSONs and transcripts in `docs/episodes/` — there is no other state.

## Documented knowledge

- `docs/solutions/` — documented solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.
- `CONCEPTS.md` — shared domain vocabulary (entities, named processes, status concepts). Relevant when orienting to the codebase or discussing domain terms.

## Runtime requirements

- **Node.js 20** (nvm default; the update script ensures Node 20 is installed and active)
- **ffmpeg + ffprobe** on PATH (pre-installed on Cloud Agent VMs)
- API keys for full pipeline only (see below)

## Key commands

All commands are defined in `package.json`:

| Command | What it does | Needs API keys? |
|---|---|---|
| `npm run build` | Type-check via `tsc --noEmit` — the only static check (no ESLint/Prettier configured) | No |
| `npm run preflight` | Fail-fast env + binary checks (keys, `FEED_BASE_URL`, ffmpeg/ffprobe) — no network LLM/RSS calls | No (reads env; does not call providers) |
| `npm test` | Smoke test — fetches live RSS feeds, asserts articles come back (~10-35s) | No |
| `npm run test:unit` | Unit tests (publish/feed XML generation, preflight, fetch dedup, script style, verifyDeploy, etc.) | No |
| `npm start` | Full end-to-end pipeline (preflight → fetch → curate → script → TTS → audio → publish); skips when today's episode is already on disk | Yes |
| `npm run diagnose:script-model` | Probe OpenRouter script structured-output without TTS/publish; set `EPISODE_DATE` to replay a published day's curation + style snippets | Yes (`OPENROUTER_API_KEY`) |
| `npm run style:report` | Print per-episode prose metrics (sentence-length variance, antithesis/triad/metadiscourse counts) + top repeated 3/4-grams across recent transcripts in `docs/episodes/` | No (reads local transcripts only) |
| `npm run tts:sample` | A/B synthesis of one fixed paragraph across candidate TTS models/voices into `tmp/tts-samples/` | Yes (skips candidates without a key) |
| `npm run stingers:generate` | One-time music stinger asset generation (Lyria 3 via OpenRouter) into `assets/audio/` | Yes (`OPENROUTER_API_KEY`) |

Run a single test: `npx tsx --test test/<name>.test.ts` (tests use `node:test`; the exception is `test/publish.apple-rss.test.ts`, which is run directly as `npx tsx test/publish.apple-rss.test.ts`).

Manual publish check (not an npm script): `FEED_BASE_URL=… npx tsx scripts/verify-deploy.ts` — polls the live Pages feed for today's episode GUID.

## Environment variables

For `npm start` (full pipeline), create a `.env` in the repo root (no checked-in `.env.example`) with:
- `OPENROUTER_API_KEY` — for curation, default script generation, and TTS when `TTS_PROVIDER=openrouter`
- `OPENROUTER_SCRIPT_MODEL` (optional, comma-separated fallback list, default: `anthropic/claude-sonnet-4.6, google/gemini-3.1-pro-preview, openai/gpt-4o-mini`; `openai/...` entries use `OPENAI_API_KEY` directly when available; mini is last because it ignores much of the voice-rule block)
- `OPENROUTER_SCRIPT_TIMEOUT_MS` (optional, default: `360000` — script JSON-schema calls can exceed 180s from GitHub Actions)
- `EAR_EDIT_ENABLED` (optional, default: `true`; set `false`/`0`/`off`/`no` to skip the post-script copy-edit pass in `src/earEdit.ts` and synthesize the script stage's output unedited)
- `OPENROUTER_EAR_EDIT_MODEL` (optional; same comma-separated fallback format as `OPENROUTER_SCRIPT_MODEL`; defaults to `OPENROUTER_SCRIPT_MODEL`'s value when unset)
- `OPENAI_API_KEY` — for `openai/...` script fallbacks and TTS when `TTS_PROVIDER=openai`
- `GEMINI_API_KEY` — for TTS when `TTS_PROVIDER=gemini` or the show voice is a designed `voice_…` id. The key must belong to the Google project that created the voice
- `FEED_BASE_URL` — public URL where `docs/` is served
- `TTS_PROVIDER` (optional, `openai` (default), `openrouter`, or `gemini`. A `voice_…` id in `config/show.json` selects `gemini` when this is unset)
- `TTS_MODEL` (optional; per provider — openai default: `gpt-4o-mini-tts`, openrouter default: `google/gemini-3.1-flash-tts-preview`, gemini default: `gemini-3.8-flash-tts`. An OpenAI model id is not sent to Gemini)
- `TTS_VOICE` (optional; single-host voice — openai default `cedar` via `src/speakerProfiles.ts`, Gemini prebuilt default `Charon`, or a designed `voice_…` id. A set Actions variable overrides the show file; preflight fails if that override would drop a designed voice)
- `TTS_GLOBAL_STYLE`, `TTS_NARRATOR_STYLE`, `TTS_INTRO_STYLE`, `TTS_STORY_STYLE`, `TTS_OUTRO_STYLE` (optional delivery-instruction overrides; OpenAI `gpt-4o-mini-tts` only)
- `AUDIO_CUES_ENABLED` (optional; default on. Set `false`/`0`/`off`/`no` to disable section stingers in `src/audio.ts`)
- `AUDIO_CUE_STYLE` (optional; `tone` (default), `chime`, `tick`, or `asset` for committed music stingers in `assets/audio/`, generated once via `npm run stingers:generate`. Missing asset files fall back to `tone`. See `docs/solutions/best-practices/audio-section-cues-and-stingers.md`)
- `INTEREST_PROFILE` (optional; free-text override of the listener interest profile that nudges curation importance scores. Unset uses `DEFAULT_INTEREST_PROFILE` in `src/interests.ts`. Set to empty/whitespace to disable personalization for that run. Forwarded from Actions vars in `daily.yml`.)
- `HEALTHCHECK_URL` (optional; dead-man's-switch monitoring. The base ping URL of a Healthchecks.io-style check — the pipeline pings `<url>/start` at the start, `<url>` on success, and `<url>/fail` on failure. Unset disables monitoring. Exposed to the daily workflow via the `HEALTHCHECK_URL` Actions secret.)
- `STAGE_CACHE_DIR` (optional; local dev only. When set, the curate, script, and earEdit stages cache their output by a content hash of their input, so re-running `npm start` after a later-stage failure reuses the LLM results instead of re-paying for them. The script cache key includes `recentStyle` snippets and the phrase profile; the earEdit key includes the script text plus per-cluster notes. Unset disables it. Single-machine only — the daily CI run uses a fresh runner, so this does not affect CI. See `docs/solutions/best-practices/stage-cache-for-local-reruns.md`)

`npm test` and `npm run build` work without any API keys. Full env / Actions variable lists live in `README.md`.

## Gotchas

- **No lint command.** There is no ESLint or Prettier configured. `npm run build` (`tsc --noEmit`) is the only static analysis check.
- **nvm is sourced automatically** via `~/.bashrc`. The update script sets Node 20 as the nvm default, so `node` and `npm` resolve correctly in new sessions without manual sourcing.
- **Smoke test hits live feeds** and takes ~10-35 seconds depending on network. Some feeds may return 0 articles if there's no recent content, but the test still passes as long as at least one article total is fetched.
- **Full pipeline run** (`npm start`) writes output files to `docs/episodes/` and regenerates `docs/feed.xml`. These changes should not be committed in dev unless intentional.
- **Already-published skip:** if both `docs/episodes/YYYY-MM-DD.json` and `.mp3` exist for today's episode date, `npm start` exits before preflight/paid stages (backup-cron / same-day re-run guard). Delete those files locally only when you intentionally want to regenerate. CI still runs **publish verification** after skip so a stuck Pages deploy can recover.
- **Fetch vs curate dedup:** `src/fetch.ts` drops duplicate/tracking-variant URLs before curation; `src/curate.ts` still clusters different URLs about the same story. See `CONCEPTS.md` and `docs/solutions/best-practices/fetch-url-deduplication-before-curation.md`.
- **Interest profile:** curation salience nudge via `src/interests.ts` / `INTEREST_PROFILE` — weighting, not a filter; empty override disables the prompt block. See `docs/solutions/best-practices/interest-profile-curation-salience.md`.
- **TTS pronunciations + inline tags:** respellings apply only at the speech boundary (`src/pronunciations.ts`); Gemini TTS inline tags are allow-listed in `src/audioTags.ts` and stripped from transcripts. See `docs/solutions/best-practices/tts-pronunciations-and-inline-audio-tags.md`.
- **Script anti-repetition:** style snippets from recent transcripts + daily intro/outro/segment-shape moves + a statistical phrase tripwire + hard outro-mold validators, followed by a non-blocking ear-edit pass (`src/earEdit.ts`) before TTS. `BANNED_SCRIPT_PHRASES` in `src/script.ts` is frozen (comment says so) — new AI-sounding tics are caught by the phrase tripwire, not by adding entries. There is no daily persona rotation; one persistent host is defined in `src/voice.ts`. Run `npm run style:report` to check whether recent episodes are actually varying. See `docs/solutions/best-practices/script-anti-repetition-style-memory.md`.
- **Show tune page:** voice, exemplars, tone notes, and TTS delivery live in `config/show.json` and override the TypeScript defaults. Edit them at `/tune/` on the Pages site (commits straight to `main`). A non-empty `TTS_*` Actions variable still wins over the file's delivery fields. See `docs/solutions/best-practices/show-tune-page.md`.
- **Stance + specifics:** curator-extracted `specifics` and per-segment `stance` round-trip through the sidecar and ledger so follow-ups can revisit the prior take; ear edit must not rewrite stance. See `docs/solutions/best-practices/stance-memory-and-curator-specifics.md`.
- **Publish ≠ push:** a successful commit does not mean listeners can fetch the episode — see `docs/solutions/workflow-issues/github-pages-publish-verification.md`.
- **Retention is age-based:** `RETENTION_DAYS` (14) governs both feed membership and disk pruning via `selectFeedRecords` / `pruneOldEpisodes`. `FEED_LIMIT` is a defensive count cap only. Publish/feed unit tests that touch the real `docs/` tree must pass `{ prune: false }` or they will delete committed episode files. See `docs/solutions/best-practices/age-based-episode-retention.md`.
- **Local stage cache:** `STAGE_CACHE_DIR` caches curate/script/earEdit by input hash for local re-runs after late-stage failures; cache I/O is non-fatal and CI never sets the var. See `docs/solutions/best-practices/stage-cache-for-local-reruns.md`.
- **Section cues:** stingers are ffmpeg program structure (`AUDIO_CUES_ENABLED` / `AUDIO_CUE_STYLE`), padded ~0.7s at boundaries, with `asset` falling back to `tone` when files are missing — not the same as TTS inline tags. See `docs/solutions/best-practices/audio-section-cues-and-stingers.md`.
- **Dependabot:** PRs require manual review and merge; automatic merging is disabled because the repository did not require checks or approving reviews. See `docs/solutions/workflow-issues/dependabot-auto-merge.md`.
- **Feature branches:** update them by merging `main`, not rebasing (`docs/solutions/workflow-issues/updating-feature-branches-merge-not-rebase.md`).
