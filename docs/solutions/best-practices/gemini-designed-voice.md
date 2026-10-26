---
title: Gemini designed voices call the Gemini API, not OpenRouter
date: 2026-09-26
category: docs/solutions/best-practices
module: tts / geminiTts / showConfig
problem_type: best_practice
component: src/geminiTts.ts, src/ttsProvider.ts, src/preflight.ts, src/index.ts, config/show.json
severity: medium
applies_when:
  - Using a Gemini Voice Design id (voice_…) as the host voice
  - Switching TTS to Gemini 3.8 Flash TTS
  - A tune-page voice id is ignored or the morning run fails at speech
  - Debugging a `tts.voice_check` log line or a post-preflight 403/404
tags: [tts, gemini, voice-design, accent, preflight, voice-check]
---

# Gemini designed voices call the Gemini API, not OpenRouter

## Context

Voice Design stores a `voice_…` id in the Google project that created it. OpenRouter speaks through its own Google account, so that id does not resolve there, and the OpenAI voice list rejects it. The direct Gemini path (`TTS_PROVIDER=gemini`, or a `voice_…` id in `config/show.json` with the provider unset) calls `gemini-3.8-flash-tts` with `GEMINI_API_KEY` from that same project.

Gemini 3.8 reads the transcript verbatim. Delivery (narrator line, section pace, segment hint) goes in `speech_metadata.style`. Square-bracket tags such as `[chuckles]` are stripped on this path so they are not spoken. The designed voice carries accent and timbre; style is situational.

A project-mismatched designed voice returns 404 on every speech request. Without an early probe, the weekday run would spend ~4 minutes on curation/script before failing at TTS.

## Guidance

1. Create the voice in Google AI Studio with the key's project. Copy the `voice_…` id into the tune page Voice id field (or `config/show.json` `tts.voice`).
2. Add the `GEMINI_API_KEY` Actions secret from that same project. The daily workflow forwards it.
3. Clear `TTS_VOICE` and `TTS_PROVIDER` if they are set to an OpenAI voice or `openai` / `openrouter`. Preflight fails with the variable name when either would drop the designed voice.
4. On `npm start`, after offline preflight, `assertGeminiVoiceReachable` (`src/geminiTts.ts`, called from `src/index.ts`) speaks one word (`"Check."`) with the configured model/voice **before** fetch/curate. Behavior:
   - **HTTP 403/404** → hard fail. For a designed `voice_…` id, the error also lists custom voices visible to this key via `listGeminiCustomVoices` (`GET /v1beta/voices`), so the run log shows whether the key or the id is wrong. Fix: replace the Actions secret with a key from the voice's project, or pick another voice on the tune page.
   - **Other failures** (timeout, 5xx) → log `tts.voice_check` with `status: "warn"` and continue; the real TTS stage still retries those.
   - **Success** → log `tts.voice_check` `status: "ok"`; for a designed voice, include `voiceExpiresAt` when the list call returns it.

**Stored custom voices expire after a year without use.** Per the [voice replication docs](https://ai.google.dev/gemini-api/docs/voice-replication), a `store=True` voice (`voice_…`, designed or replicated) is kept for 1 year, and each synthesis with it restarts that year, so a voice the daily show uses does not expire. A stateless `voicekey_…` (`store=False`) expires 7 days after creation. The [Voices cookbook](https://github.com/google-gemini/cookbook/blob/main/quickstarts/Get_Started_Voices.ipynb) says stored voices last 7 days; the API docs supersede it. An expired id returns the same 404.

5. Audition with `npm run tts:sample -- gemini:gemini-3.8-flash-tts:voice_…`.

A prebuilt name such as `Charon` still works on this provider. An OpenAI model id left in `TTS_MODEL` is ignored so it is not sent to Gemini.

`npm run preflight` stays offline — it does **not** run this probe. Only `npm start` (and the daily workflow) does.

## Related

- Code: `assertGeminiVoiceReachable`, `listGeminiCustomVoices` in `src/geminiTts.ts`; call site in `src/index.ts` after `assertPreflight`
- Tests: `test/geminiTts.test.ts`
- `docs/solutions/best-practices/southern-host-voice-and-accent.md`
- `docs/solutions/best-practices/preflight-fail-fast-before-paid-stages.md`
- `docs/solutions/best-practices/show-tune-page.md`
- README Troubleshooting → Gemini voice check fails with HTTP 403/404
