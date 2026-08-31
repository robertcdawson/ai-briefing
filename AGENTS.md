# AGENTS.md

## Cursor Cloud specific instructions

### Overview

**ai-briefing** is a daily AI news podcast pipeline (no web server). It fetches RSS feeds, curates stories via LLM, generates a spoken script, synthesizes audio via TTS, and publishes an RSS podcast feed. There is no database — state lives in `docs/episodes/*.json` sidecars + git.

### Documented knowledge

- `docs/solutions/` — documented solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.
- `CONCEPTS.md` — shared domain vocabulary (entities, named processes, status concepts). Relevant when orienting to the codebase or discussing domain terms.

### Runtime requirements

- **Node.js 20** (nvm default; the update script ensures Node 20 is installed and active)
- **ffmpeg + ffprobe** on PATH (pre-installed on Cloud Agent VMs)
- API keys for full pipeline only (see below)

### Key commands

All commands are defined in `package.json`:

| Command | What it does | Needs API keys? |
|---|---|---|
| `npm run build` | Type-check via `tsc --noEmit` | No |
| `npm run preflight` | Fail-fast env + binary checks (keys, `FEED_BASE_URL`, ffmpeg/ffprobe) — no network LLM/RSS calls | No (reads env; does not call providers) |
| `npm test` | Smoke test — fetches live RSS feeds, asserts articles come back | No |
| `npm run test:unit` | Unit tests (publish/feed XML generation, preflight, fetch dedup, script style, verifyDeploy, etc.) | No |
| `npm start` | Full end-to-end pipeline (preflight → fetch → curate → script → TTS → audio → publish); skips when today's episode is already on disk | Yes |
| `npm run diagnose:script-model` | Probe OpenRouter script structured-output without TTS/publish; set `EPISODE_DATE` to replay a published day's curation + style snippets | Yes (`OPENROUTER_API_KEY`) |
| `npm run style:report` | Print per-episode prose metrics (sentence-length variance, antithesis/triad/metadiscourse counts) + top repeated 3/4-grams across recent transcripts in `docs/episodes/` | No (reads local transcripts only) |
| `npm run tts:sample` | A/B synthesis of one fixed paragraph across candidate TTS models/voices into `tmp/tts-samples/` | Yes (skips candidates without a key) |
| `npm run stingers:generate` | One-time music stinger asset generation (Lyria 3 via OpenRouter) into `assets/audio/` | Yes (`OPENROUTER_API_KEY`) |

Manual publish check (not an npm script): `FEED_BASE_URL=… npx tsx scripts/verify-deploy.ts` — polls the live Pages feed for today's episode GUID.

### Environment variables

For `npm start` (full pipeline), create a `.env` in the repo root (no checked-in `.env.example`) with:
- `OPENROUTER_API_KEY` — for curation, default script generation, and TTS when `TTS_PROVIDER=openrouter`
- `OPENROUTER_SCRIPT_MODEL` (optional, comma-separated fallback list, default: `anthropic/claude-sonnet-4.6, google/gemini-3.1-pro-preview, openai/gpt-4o-mini`; `openai/...` entries use `OPENAI_API_KEY` directly when available; mini is last because it ignores much of the voice-rule block)
- `OPENROUTER_SCRIPT_TIMEOUT_MS` (optional, default: `360000` — script JSON-schema calls can exceed 180s from GitHub Actions)
- `EAR_EDIT_ENABLED` (optional, default: `true`; set `false`/`0`/`off`/`no` to skip the post-script copy-edit pass in `src/earEdit.ts` and synthesize the script stage's output unedited)
- `OPENROUTER_EAR_EDIT_MODEL` (optional; same comma-separated fallback format as `OPENROUTER_SCRIPT_MODEL`; defaults to `OPENROUTER_SCRIPT_MODEL`'s value when unset)
- `OPENAI_API_KEY` — for `openai/...` script fallbacks and TTS when `TTS_PROVIDER=openai`
- `FEED_BASE_URL` — public URL where `docs/` is served
- `TTS_PROVIDER` (optional, `openai` (default) or `openrouter`)
- `TTS_MODEL` (optional; per provider — openai default: `gpt-4o-mini-tts`, openrouter default: `google/gemini-3.1-flash-tts-preview`)
- `TTS_VOICE` (optional; single-host voice — openai default `marin` via `src/speakerProfiles.ts`, Gemini TTS default `Charon`)
- `TTS_GLOBAL_STYLE`, `TTS_NARRATOR_STYLE`, `TTS_INTRO_STYLE`, `TTS_STORY_STYLE`, `TTS_OUTRO_STYLE` (optional delivery-instruction overrides; OpenAI `gpt-4o-mini-tts` only)
- `AUDIO_CUE_STYLE` (optional; `tone` (default), `chime`, `tick`, or `asset` for committed music stingers in `assets/audio/`, generated once via `npm run stingers:generate`)
- `HEALTHCHECK_URL` (optional; dead-man's-switch monitoring. The base ping URL of a Healthchecks.io-style check — the pipeline pings `<url>/start` at the start, `<url>` on success, and `<url>/fail` on failure. Unset disables monitoring. Exposed to the daily workflow via the `HEALTHCHECK_URL` Actions secret.)
- `STAGE_CACHE_DIR` (optional; local dev only. When set, the curate, script, and earEdit stages cache their output by a content hash of their input, so re-running `npm start` after a later-stage failure reuses the LLM results instead of re-paying for them. The script cache key includes `recentStyle` snippets and the phrase profile; the earEdit key includes the script text plus per-cluster notes. Unset disables it. Single-machine only — the daily CI run uses a fresh runner, so this does not affect CI.)

`npm test` and `npm run build` work without any API keys. Full env / Actions variable lists live in `README.md`.

### Gotchas

- **No lint command.** There is no ESLint or Prettier configured. `npm run build` (`tsc --noEmit`) is the only static analysis check.
- **nvm is sourced automatically** via `~/.bashrc`. The update script sets Node 20 as the nvm default, so `node` and `npm` resolve correctly in new sessions without manual sourcing.
- **Smoke test hits live feeds** and takes ~10-35 seconds depending on network. Some feeds may return 0 articles if there's no recent content, but the test still passes as long as at least one article total is fetched.
- **Full pipeline run** (`npm start`) writes output files to `docs/episodes/` and regenerates `docs/feed.xml`. These changes should not be committed in dev unless intentional.
- **Already-published skip:** if both `docs/episodes/YYYY-MM-DD.json` and `.mp3` exist for today's episode date, `npm start` exits before preflight/paid stages (backup-cron / same-day re-run guard). Delete those files locally only when you intentionally want to regenerate. CI still runs **publish verification** after skip so a stuck Pages deploy can recover.
- **Fetch vs curate dedup:** `src/fetch.ts` drops duplicate/tracking-variant URLs before curation; `src/curate.ts` still clusters different URLs about the same story. See `CONCEPTS.md` and `docs/solutions/best-practices/fetch-url-deduplication-before-curation.md`.
- **Script anti-repetition:** style snippets from recent transcripts + daily intro/outro/segment-shape moves + a statistical phrase tripwire + hard outro-mold validators, followed by a non-blocking ear-edit pass (`src/earEdit.ts`) before TTS. `BANNED_SCRIPT_PHRASES` in `src/script.ts` is frozen (comment says so) — new AI-sounding tics are caught by the phrase tripwire, not by adding entries. There is no daily persona rotation; one persistent host is defined in `src/voice.ts`. Run `npm run style:report` to check whether recent episodes are actually varying. See `docs/solutions/best-practices/script-anti-repetition-style-memory.md`.
- **Stance + specifics:** curator-extracted `specifics` and per-segment `stance` round-trip through the sidecar and ledger so follow-ups can revisit the prior take; ear edit must not rewrite stance. See `docs/solutions/best-practices/stance-memory-and-curator-specifics.md`.
- **Publish ≠ push:** a successful commit does not mean listeners can fetch the episode — see `docs/solutions/workflow-issues/github-pages-publish-verification.md`.
- **Retention is age-based:** `RETENTION_DAYS` (14) governs both feed membership and disk pruning via `selectFeedRecords` / `pruneOldEpisodes`. `FEED_LIMIT` is a defensive count cap only. Publish/feed unit tests that touch the real `docs/` tree must pass `{ prune: false }` or they will delete committed episode files. See `docs/solutions/best-practices/age-based-episode-retention.md`.
- **Dependabot auto-merge:** `.github/workflows/dependabot-auto-merge.yml` only *enables* squash auto-merge for `dependabot[bot]` PRs — it does not approve or skip required checks. See `docs/solutions/workflow-issues/dependabot-auto-merge.md`.
