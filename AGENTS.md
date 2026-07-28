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
| `npm test` | Smoke test — fetches live RSS feeds, asserts articles come back | No |
| `npm run test:unit` | Unit tests (publish/feed XML generation) | No |
| `npm start` | Full end-to-end pipeline (fetch → curate → script → TTS → audio → publish) | Yes |
| `npm run tts:sample` | A/B synthesis of one fixed paragraph across candidate TTS models/voices into `tmp/tts-samples/` | Yes (skips candidates without a key) |
| `npm run stingers:generate` | One-time music stinger asset generation (Lyria 3 via OpenRouter) into `assets/audio/` | Yes (`OPENROUTER_API_KEY`) |

### Environment variables

For `npm start` (full pipeline), a `.env` file is required with:
- `OPENROUTER_API_KEY` — for curation, default script generation, and TTS when `TTS_PROVIDER=openrouter`
- `OPENROUTER_SCRIPT_MODEL` (optional, comma-separated fallback list, default: `anthropic/claude-sonnet-4.6, openai/gpt-4o-mini, google/gemini-3.1-pro-preview`; `openai/...` entries use `OPENAI_API_KEY` directly when available)
- `OPENROUTER_SCRIPT_TIMEOUT_MS` (optional, default: `360000` — script JSON-schema calls can exceed 180s from GitHub Actions)
- `OPENAI_API_KEY` — for `openai/...` script fallbacks and TTS when `TTS_PROVIDER=openai`
- `FEED_BASE_URL` — public URL where `docs/` is served
- `TTS_PROVIDER` (optional, `openai` (default) or `openrouter`)
- `TTS_MODEL` (optional; per provider — openai default: `gpt-4o-mini-tts`, openrouter default: `google/gemini-3.1-flash-tts-preview`)
- `TTS_VOICE` (optional; single-host voice — openai default `marin` via `src/speakerProfiles.ts`, Gemini TTS default `Charon`)
- `TTS_GLOBAL_STYLE`, `TTS_NARRATOR_STYLE`, `TTS_INTRO_STYLE`, `TTS_STORY_STYLE`, `TTS_OUTRO_STYLE` (optional delivery-instruction overrides; OpenAI `gpt-4o-mini-tts` only)
- `AUDIO_CUE_STYLE` (optional; `tone` (default), `chime`, `tick`, or `asset` for committed music stingers in `assets/audio/`, generated once via `npm run stingers:generate`)
- `HEALTHCHECK_URL` (optional; dead-man's-switch monitoring. The base ping URL of a Healthchecks.io-style check — the pipeline pings `<url>/start` at the start, `<url>` on success, and `<url>/fail` on failure. Unset disables monitoring. Exposed to the daily workflow via the `HEALTHCHECK_URL` Actions secret.)
- `STAGE_CACHE_DIR` (optional; local dev only. When set, the curate and script stages cache their output by a content hash of their input, so re-running `npm start` after a later-stage failure reuses the LLM results instead of re-paying for them. Unset disables it. Single-machine only — the daily CI run uses a fresh runner, so this does not affect CI.)

Copy `.env.example` to `.env` and fill in. `npm test` and `npm run build` work without any API keys.

### Gotchas

- **No lint command.** There is no ESLint or Prettier configured. `npm run build` (`tsc --noEmit`) is the only static analysis check.
- **nvm is sourced automatically** via `~/.bashrc`. The update script sets Node 20 as the nvm default, so `node` and `npm` resolve correctly in new sessions without manual sourcing.
- **Smoke test hits live feeds** and takes ~10-35 seconds depending on network. Some feeds may return 0 articles if there's no recent content, but the test still passes as long as at least one article total is fetched.
- **Full pipeline run** (`npm start`) writes output files to `docs/episodes/` and regenerates `docs/feed.xml`. These changes should not be committed in dev unless intentional.
