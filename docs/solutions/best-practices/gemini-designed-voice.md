---
title: Gemini designed voices call the Gemini API, not OpenRouter
date: 2026-09-26
category: docs/solutions/best-practices
module: tts / geminiTts / showConfig
problem_type: best_practice
component: src/geminiTts.ts, src/ttsProvider.ts, src/preflight.ts, config/show.json
severity: medium
applies_when:
  - Using a Gemini Voice Design id (voice_…) as the host voice
  - Switching TTS to Gemini 3.8 Flash TTS
  - A tune-page voice id is ignored or the morning run fails at speech
tags: [tts, gemini, voice-design, accent, preflight]
---

# Gemini designed voices call the Gemini API, not OpenRouter

## Context

Voice Design stores a `voice_…` id in the Google project that created it. OpenRouter speaks through its own Google account, so that id does not resolve there, and the OpenAI voice list rejects it. The direct Gemini path (`TTS_PROVIDER=gemini`, or a `voice_…` id in `config/show.json` with the provider unset) calls `gemini-3.8-flash-tts` with `GEMINI_API_KEY` from that same project.

Gemini 3.8 reads the transcript verbatim. Delivery (narrator line, section pace, segment hint) goes in `speech_metadata.style`. Square-bracket tags such as `[chuckles]` are stripped on this path so they are not spoken. The designed voice carries accent and timbre; style is situational.

## Guidance

1. Create the voice in Google AI Studio with the key's project. Copy the `voice_…` id into the tune page Voice id field (or `config/show.json` `tts.voice`).
2. Add the `GEMINI_API_KEY` Actions secret from that same project. The daily workflow forwards it.
3. Clear `TTS_VOICE` and `TTS_PROVIDER` if they are set to an OpenAI voice or `openai` / `openrouter`. Preflight fails with the variable name when either would drop the designed voice.
4. Audition with `npm run tts:sample -- gemini:gemini-3.8-flash-tts:voice_…`.

A prebuilt name such as `Charon` still works on this provider. An OpenAI model id left in `TTS_MODEL` is ignored so it is not sent to Gemini.

## Related

- `docs/solutions/best-practices/southern-host-voice-and-accent.md`
- `docs/solutions/best-practices/preflight-fail-fast-before-paid-stages.md`
- `docs/solutions/best-practices/show-tune-page.md`
