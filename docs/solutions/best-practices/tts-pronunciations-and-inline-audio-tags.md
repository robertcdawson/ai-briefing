---
title: Respell hard names for TTS and keep inline delivery tags provider-aware
date: 2026-09-07
category: docs/solutions/best-practices
module: tts / pronunciations / audioTags
problem_type: best_practice
component: src/pronunciations.ts, src/audioTags.ts, src/tts.ts, src/publish.ts
severity: medium
applies_when:
  - A lab, model, or researcher name is mispronounced in the MP3
  - Switching TTS_PROVIDER between openai and openrouter/Gemini
  - Extending the pronunciation lexicon or the inline-tag allow-list
  - Debugging why transcripts lack [chuckles]-style tags that appear in the script
tags: [tts, pronunciation, lexicon, inline-audio-tags, gemini, transcript]
---

# Respell hard names for TTS and keep inline delivery tags provider-aware

## Context

AI news is dense with names TTS engines mangle (Qwen, Mistral, Groq/Grok, researcher names). OpenAI `gpt-4o-mini-tts` has no SSML, and OpenRouter TTS routes also lack a portable phoneme channel, so the provider-agnostic fix is to **respell** offending terms in the text sent to the synthesizer only.

Separately, Gemini TTS models interpret sparse bracketed cues like `[chuckles]` as performance hints. OpenAI models would read those brackets aloud, so the allow-list must be shared by script prompting, TTS synthesis, and transcript writing — and stripped when the active model does not support them.

## Pronunciation lexicon (M9)

**Boundary:** `applyPronunciations()` runs inside `buildPartSpeechRequest` in `src/tts.ts` **after** optional tag stripping and **only** on the speech `input`. Canonical script text, sidecar JSON, chapters, and `*.transcript.txt` keep the correct spelling.

| Rule | Detail |
|---|---|
| Matching | Whole-word, case-insensitive (`\b…\b`) |
| Overlaps | Longer terms applied first via one alternation regex (avoids re-matching inside a prior substitution) |
| Edit site | Add `{ term, say }` to `PRONUNCIATIONS` in `src/pronunciations.ts` |

Example: script/transcript say `Qwen`; spoken audio receives `Chwen`.

## Inline audio tags

Allow-list lives in `ALLOWED_INLINE_AUDIO_TAGS` (`src/audioTags.ts`): `[chuckles]`, `[sighs]`, `[curious]`, `[skeptical]`, `[excited]`, `[deadpan]`.

| Stage | Behavior |
|---|---|
| Script | When `resolveTTSProviderConfig().supportsInlineAudioTags` is true (Gemini TTS model ids), `buildInlineAudioTagRules()` is appended; otherwise the prompt forbids bracketed markup. |
| TTS | `supportsInlineAudioTags(model)` → keep tags in speech input; else `stripInlineAudioTags` before `applyPronunciations`. |
| Transcript | `publish.ts` always strips allow-listed tags from the written transcript so readers never see performance markup. |

Detection is `/gemini[^/]*-tts/i` on the model id — non-TTS Gemini models do not enable tags.

## Guidance

**Do**

1. Fix mangled names by adding a lexicon entry, not by rewriting the published transcript.
2. Keep the allow-list small and news-safe; update script voice tests when adding a tag.
3. Remember delivery **hints** (3–6 word OpenAI instruction notes) are a different channel from inline tags — see Delivery hint in `CONCEPTS.md`.

**Do not**

- Apply pronunciations before writing the transcript (listeners reading show notes would see phonetic spellings).
- Add free-form `[…]` tags outside the allow-list — non-allow-listed brackets are preserved as literal text and may be spoken.
- Assume OpenAI delivery-instruction styles (`TTS_*_STYLE`) work on the Gemini path; that path uses inline tags instead.

## Example

```bash
# Confirm lexicon behavior (no API key)
npm run test:unit -- --test-name-pattern=pronunciations|InlineAudio|supportsInline

# Hear a candidate voice with tags enabled (needs keys)
TTS_PROVIDER=openrouter TTS_MODEL=google/gemini-3.1-flash-tts-preview npm run tts:sample
```

Add a name:

```ts
// src/pronunciations.ts
{ term: "NewLab", say: "New-Lab" },
```

## Related

- Glossary: Pronunciation lexicon, Inline audio tags in `CONCEPTS.md`
- Tests: `test/pronunciations.test.ts`, `test/tts.provider.test.ts`, `test/tts.request.test.ts`, `test/script.voice.test.ts`
- Provider resolution: `src/ttsProvider.ts`
