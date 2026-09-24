---
title: Tune the host's tone from a phone page that commits config/show.json
date: 2026-09-24
category: docs/solutions/best-practices
module: showConfig / script / earEdit / tts
problem_type: best_practice
component: src/showConfig.ts, config/show.json, docs/tune/index.html, src/script.ts, src/earEdit.ts, src/speakerProfiles.ts
severity: medium
applies_when:
  - The host's wording or cadence needs a change without a pull request
  - A tone edit did not show up in the next episode
  - Deciding whether an Actions variable or the tune page owns a delivery field
tags: [voice, tone, show-config, tune-page, tts, script]
---

# Tune the host's tone from a phone page that commits config/show.json

## Context

The host's wording lived only in `src/voice.ts`, and the accent lived in `src/speakerProfiles.ts` unless a GitHub Actions variable overrode it. Changing the language meant a code edit. The listener hears model cadence clearly and needs to correct it after an episode, from a phone, without opening a pull request or the Actions variables screen.

## How it works

```
docs/tune/  →  commits config/show.json to main
loadShowConfig()  →  script prompt, ear-edit prompt, TTS direction
blank field or missing file  →  built-in defaults
non-empty TTS_* env var  →  wins over the file's delivery fields
```

| Piece | Where it goes |
|---|---|
| Tone notes | End of the script prompt and the ear-edit prompt. Empty notes add nothing. |
| Host speech, humor, refusals, exemplars | Same blocks as `src/voice.ts`, using the file's text. |
| Spoken delivery and voice id | `resolveTTSDirection` / `resolveTTSProviderConfig`, after env vars. |

Tone notes outrank the default register and the emphasis budget when they conflict. They do not outrank facts or the FATAL rules. The copy editor is told not to sand the script back to a generic newsreader when notes are present.

A missing, unreadable, or invalid file logs `phase: show-config, status: fallback` and the run continues on the built-in host. The show config is part of the script and ear-edit stage-cache keys, so a local re-run after a tone edit does not reuse the previous script.

## Guidance

**Do**

- Edit from `https://<pages-host>/<repo>/tune/` after the page is on `main`.
- Use a fine-grained token with Contents read and write on this repository only. Leave it in the browser; do not commit it.
- Put "stop sounding like this" in tone notes. Put the voice you want in "How they talk" and in one or two passages.
- Clear a non-empty `TTS_NARRATOR_STYLE` or `TTS_VOICE` Actions variable if the page's delivery or voice id should win. The workflow forwards those variables, and a non-empty value beats the file.

**Don't**

- Don't expect a save to change an episode that already published today. The pipeline skips paid stages when today's mp3 and sidecar exist.
- Don't put the token in the repo, the tone notes, or a screenshot.
- Don't phonetic-spell an accent into the script. Delivery instructions are the accent channel, and only the OpenAI speech path honors them.

## Related

- `CONCEPTS.md` — Show config, Host identity, Emphasis budget
- `docs/solutions/best-practices/southern-host-voice-and-accent.md`
- `docs/solutions/best-practices/script-anti-repetition-style-memory.md`
