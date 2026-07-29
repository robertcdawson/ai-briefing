---
title: Fail fast on missing keys and ffmpeg before paid pipeline stages
date: 2026-07-29
category: docs/solutions/best-practices
module: preflight
problem_type: best_practice
component: src/preflight.ts
severity: medium
applies_when:
  - Adding required env or binary dependencies to the daily pipeline
  - Debugging a local or CI run that failed after expensive LLM/TTS work
  - Changing TTS provider routing (OpenAI vs OpenRouter)
tags: [preflight, configuration, ffmpeg, cost, pipeline, fail-fast]
---

# Fail fast on missing keys and ffmpeg before paid pipeline stages

## Context

An unattended weekday run that discovers a missing `OPENAI_API_KEY`, bad `FEED_BASE_URL`, or absent `ffmpeg` **after** curation/script has already spent OpenRouter/OpenAI quota is pure waste. The pipeline now runs `assertPreflight()` in `src/index.ts` immediately after the already-published skip guard and before `fetch` / paid stages.

`npm run preflight` exposes the same checks without starting the pipeline.

## Guidance

**What preflight checks today**

| Check | Rule |
|---|---|
| `OPENROUTER_API_KEY` | Required (curation always routes through OpenRouter). |
| TTS API key | `OPENAI_API_KEY` when `TTS_PROVIDER=openai` (default); `OPENROUTER_API_KEY` covers OpenRouter TTS (already required). |
| `FEED_BASE_URL` | Non-empty absolute `http://` or `https://` URL. |
| `ffmpeg` / `ffprobe` | Both must exist on `PATH` (`-version` succeeds). |

**What it deliberately does not do**

- No OpenRouter / OpenAI / RSS network calls.
- No “is my key valid?” probe — that still surfaces at the first real API call.
- No skip of the already-published guard — that runs **before** preflight so backup crons stay free even when local env is incomplete.

When adding a new hard dependency (another binary, another required env for a default path), extend `src/preflight.ts` and cover it in `test/preflight.test.ts` so CI catches the gap without spending model budget.

## Example

```bash
npm run preflight
# logs: {"phase":"preflight","status":"ok","checks":[...]}

# or via the full pipeline:
npm start
# on failure throws:
# Pipeline preflight failed:
# - FEED_BASE_URL: FEED_BASE_URL must start with http:// or https://
# - ffmpeg: ffmpeg must be installed and available on PATH
```

## Why this works

Config and local-tool failures are nearly free to detect and nearly certain to abort the run later. Placing them after the disk-based already-published skip (so backups stay no-ops) and before fetch/curate preserves the cheap path while protecting the expensive path.

## Related

- Code: `src/preflight.ts`, `scripts/preflight.ts`, call site in `src/index.ts`.
- TTS routing: `src/ttsProvider.ts` (`resolveTTSProviderConfig`).
- Already-published skip: `hasPublishedEpisode` in `src/publish.ts`.
- Docs: README setup §4 and Troubleshooting → Preflight; `CONCEPTS.md` → Preflight.
