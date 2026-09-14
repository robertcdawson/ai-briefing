---
title: Section stingers are padded cues with a tone/chime/tick/asset style and loudnorm master
date: 2026-09-14
category: docs/solutions/best-practices
module: audio
problem_type: best_practice
component: src/audio.ts, scripts/generate-stinger-assets.ts
severity: low
applies_when:
  - Tuning or disabling intro/transition/outro stingers
  - Switching AUDIO_CUE_STYLE or committing music cue assets
  - Debugging chapter timestamps or episode duration that include cue pads
  - Investigating a logged fallback from asset cues to synthesized tone
tags: [audio, stingers, ffmpeg, cues, loudnorm, chapters, assets]
---

# Section stingers are padded cues with a tone/chime/tick/asset style and loudnorm master

## Context

Listeners hear short cues between the intro, each story, and the outro. Those cues are not decorative afterthoughts — they change program duration, chapter boundaries, and perceived pacing. `src/audio.ts` owns synthesis (or asset load), silence padding, concat order, EBU-style loudnorm, and ffmpeg chapter metadata.

## How it works

```
TTS segment WAVs
  → normalize sample rate/channels
  → optional cue tracks (intro / transition / outro)
  → buildStingerSequence (cue + narration + … + outro cue)
  → concat → loudnorm → MP3 + ID3 + chapters
```

### Enable / style

| Env | Behavior |
|---|---|
| `AUDIO_CUES_ENABLED` unset / truthy | Cues on (default). |
| `AUDIO_CUES_ENABLED` = `0` / `false` / `off` / `no` | Pure narration; no cue tracks. |
| `AUDIO_CUE_STYLE` = `tone` (default) | Short synthesized sine beeps. |
| `chime` | Slightly longer / softer synthesized tones. |
| `tick` | Very short synthesized markers. |
| `asset` | Committed files under `assets/audio/cue-{intro,transition,outro}.{mp3,wav}`. |

If `asset` is selected and **any** of the three files is missing, the stage logs `audio.cue_assets` with `fallback: "tone"` and synthesizes tone cues instead of failing the run.

### Padding (breathing room)

`CUE_PAD_SECONDS = 0.7`. Applied via `buildCuePadFilter`:

| Cue | Pad before | Pad after |
|---|---|---|
| intro | 0 | 0.7s |
| transition | 0.7s | 0.7s |
| outro | 0.7s | 0 |

Intro starts promptly; outro does not trail silence after the show ends; transitions breathe on both sides.

### Sequence

`buildStingerSequence` lays out:

`[intro cue] [seg0] [transition] [seg1] … [transition] [segN] [outro cue]`

Chapter / part timings in the same module account for cue durations when cues are enabled, so show notes and ID3 chapters stay aligned with the audible program.

### Mastering

The concatenated program is loudnorm'd (`loudnorm=I=-16:TP=-1.5:LRA=11`) and encoded to MP3 before publish.

### Generating asset cues once

`npm run stingers:generate` (`scripts/generate-stinger-assets.ts`) builds a short instrumental bed (Lyria via OpenRouter), carves the three cues into `assets/audio/`, and keeps the bed for free re-cuts. Listen, commit the assets, set `AUDIO_CUE_STYLE=asset`.

## Guidance

**Do**

1. Prefer `AUDIO_CUES_ENABLED=false` when A/B'ing narration-only pacing; leave style alone.
2. Commit all three `cue-intro` / `cue-transition` / `cue-outro` files before enabling `asset` in Actions — a partial set silently falls back to tone.
3. Re-check chapter lists after changing pad or cue style; durations shift even when narration text does not.
4. Keep cue levels low in asset design — loudnorm will still pull the full program to -16 LUFS integrated.

**Do not**

- Expect delivery-hint / inline audio-tag docs to cover these cues. Those are TTS speech channels; stingers are ffmpeg program structure.
- Hand-edit only one cue file and assume `asset` mode still engages.
- Treat cue pad silence as optional polish — it is baked into timing math.

## Example

```bash
# Narration only for a local listen
AUDIO_CUES_ENABLED=false npm start

# Tone cues (default)
AUDIO_CUE_STYLE=tone npm start

# One-time music assets, then:
npm run stingers:generate
# listen to assets/audio/cue-*.{mp3,wav}, commit, then:
AUDIO_CUE_STYLE=asset npm start
```

## Related

- Code: `src/audio.ts` (`resolveAudioCuesEnabled`, `resolveAudioCueStyle`, `buildStingerSequence`, `buildCuePadFilter`)
- Tests: `test/audio.stingers.test.ts`
- Ops: README → Toggle section stingers
- Glossary: Section cues in `CONCEPTS.md`
- Distinct from: `docs/solutions/best-practices/tts-pronunciations-and-inline-audio-tags.md`
