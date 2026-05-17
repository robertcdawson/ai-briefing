# AGENTS.md

## Cursor Cloud specific instructions

### Overview

**ai-briefing** is a daily AI news podcast pipeline (no web server). It fetches RSS feeds, curates stories via LLM, generates a spoken script, synthesizes audio via TTS, and publishes an RSS podcast feed. There is no database — state lives in `docs/episodes/*.json` sidecars + git.

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

### Environment variables

For `npm start` (full pipeline), a `.env` file is required with:
- `OPENROUTER_API_KEY` — for LLM calls (curate + script generation)
- `OPENROUTER_SCRIPT_MODEL` (optional, comma-separated fallback list, default: `openai/gpt-4o-mini, google/gemini-3.1-pro-preview`)
- `OPENROUTER_SCRIPT_TIMEOUT_MS` (optional, default: `360000` — OpenRouter JSON-schema script calls often exceed 180s from GitHub Actions)
- `OPENAI_API_KEY` — for TTS audio synthesis
- `FEED_BASE_URL` — public URL where `docs/` is served
- `TTS_MODEL` (optional, default: `gpt-4o-mini-tts`)
- `TTS_VOICE` (optional, default: `onyx`)

Copy `.env.example` to `.env` and fill in. `npm test` and `npm run build` work without any API keys.

### Gotchas

- **No lint command.** There is no ESLint or Prettier configured. `npm run build` (`tsc --noEmit`) is the only static analysis check.
- **nvm is sourced automatically** via `~/.bashrc`. The update script sets Node 20 as the nvm default, so `node` and `npm` resolve correctly in new sessions without manual sourcing.
- **Smoke test hits live feeds** and takes ~10-35 seconds depending on network. Some feeds may return 0 articles if there's no recent content, but the test still passes as long as at least one article total is fetched.
- **Full pipeline run** (`npm start`) writes output files to `docs/episodes/` and regenerates `docs/feed.xml`. These changes should not be committed in dev unless intentional.
