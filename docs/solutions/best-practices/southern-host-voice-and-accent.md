---
title: Southern host voice — dialect in the words, accent in the TTS instructions
date: 2026-09-18
category: docs/solutions/best-practices
module: voice / speakerProfiles / script / earEdit
problem_type: best_practice
component: src/voice.ts, src/speakerProfiles.ts, src/script.ts, src/earEdit.ts, scripts/tts-sample.ts
severity: medium
applies_when:
  - Changing the host's personality, dialect, or accent
  - The accent sounds inconsistent between chapters of one episode
  - A dialect phrase shows up under RECENTLY USED or trips the phrase tripwire
  - Choosing a TTS voice or provider for a regional accent
tags: [voice, persona, accent, dialect, tts, delivery-instructions, phrase-tripwire]
---

# Southern host voice — dialect in the words, accent in the TTS instructions

## Context

The host was rewritten from a sharp, occasionally cynical guide to a warm, plainspoken one who grew up in the Southern U.S. The goal is relatability, not a bit. None of the 43 built-in voices across OpenAI and Gemini TTS is natively Southern, so the accent has to be a delivery instruction, and the dialect has to be written by the script model without becoming a costume or a daily catchphrase.

## Where each half lives

| Layer | Owner | Lever |
|---|---|---|
| Words (rhythm, "y'all", "fixing to", a homespun comparison when it explains something) | `HOST_IDENTITY.speech` + `VOICE_EXEMPLARS` in `src/voice.ts` | Edit the identity text and the exemplars |
| Spelling | `src/script.ts` SPOKEN-DELIVERY MECHANICS | Standard spelling always; never phonetic respellings |
| Accent (soft drawl, relaxed vowels, easy pace) | `NARRATOR_PROFILE.delivery` in `src/speakerProfiles.ts` | Override with `TTS_NARRATOR_STYLE`; OpenAI path only |
| Timbre | `NARRATOR_PROFILE.defaultVoice` (`cedar`) | Override with `TTS_VOICE` |
| Preservation | `src/earEdit.ts` system prompt | Copy editor leaves dialect as written |

The split is deliberate. Writing the accent into the script ("fixin'", "gonna") breaks the synthesizer's pronunciation and leaks into the published transcript. Keeping it in `instructions` means the words stay clean and the accent can be tuned, or removed, without touching the prompt.

## Why the phrase tripwire is not exempted

`buildRecentPhraseProfile` counts 3- and 4-word phrases across the last 8 transcripts; 3 episodes lists a phrase as worn, 4 hard-rejects the attempt. Dialect is made of set phrases, so the first instinct is an allow-list. Don't. A Southern saying repeated every morning is a tic like any other, and the tripwire only flags multi-word phrases, so single markers such as "y'all" are never at risk. The script prompt tells the writer that if a dialect phrase appears under RECENTLY USED it should drop the phrase, not the voice, and the 3 attempts per model give it room to re-roll. The exemplars are trimmed for the same reason: none of them models a saying.

## Gotchas

- **Actions variables override code defaults.** Production had `TTS_VOICE=ash` set as a repository variable when this landed. The code default moved to `cedar`, but the variable wins; set it to `cedar` or clear it.
- **The accent is a per-request instruction.** Each intro, story, and outro is a separate TTS request, and the model can render the accent a little differently each time. Listen to a full episode's parts, not one sample, before judging.
- **Only the OpenAI path honors `instructions`.** Through OpenRouter (Gemini TTS), `supportsDeliveryInstructions` is hard-coded false; that path has no accent channel yet.
- **Tests pin the persona.** `test/speakerProfiles.test.ts`, `test/tts.request.test.ts`, and `test/script.voice.test.ts` assert the persona line, default voice, speech block, and exemplar hygiene. Update them with the identity, not around it.

## Audition

```bash
# Default candidates: cedar, fable, verse, ash (OpenAI), Charon, Sulafat (Gemini)
npm run tts:sample

# Try a different accent instruction without touching code
TTS_NARRATOR_STYLE="Natural solo host with an unhurried north-Georgia accent; understated, consistent, never a caricature." \
  npm run tts:sample -- openai:gpt-4o-mini-tts:cedar
```

## If the accent drifts too much

Two documented next steps, in order of effort:

1. **Gemini director's-note prefix.** Gemini 3.1 Flash TTS steers accent from natural-language notes in the text. Prepend a short note to `input` in `buildPartSpeechRequest` for the OpenRouter path and verify by ear that OpenRouter passes it through unspoken.
2. **ElevenLabs.** Eleven v3 has explicit accent tags, a voice library with natively Southern voices, Voice Design (describe the host in a sentence), and voice cloning. Needs a new provider module and roughly six times the per-episode TTS cost.

## Related

- Glossary: Host identity, Voice exemplars, Delivery hint, Phrase tripwire in `CONCEPTS.md`
- `docs/solutions/best-practices/script-anti-repetition-style-memory.md`
- `docs/solutions/best-practices/tts-pronunciations-and-inline-audio-tags.md`
