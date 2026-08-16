---
title: Stop cross-episode script molds with style snippets, daily moves, and hard validators
date: 2026-08-10
category: docs/solutions/best-practices
module: script
problem_type: best_practice
component: src/script.ts
severity: medium
applies_when:
  - Episodes share the same intro/outro/sign-off skeleton across days
  - Changing script prompts, personas, or validators
  - Debugging why a script attempt was rejected and re-rolled
  - A/B testing prompt changes against a published episode
tags: [script, anti-repetition, style-snippets, persona, validators, prompt]
---

# Stop cross-episode script molds with style snippets, daily moves, and hard validators

## Context

Transcript analysis across dozens of episodes showed the show's AI "smell" was **structural**, not stray filler: outros opened with the same "pull back… a pattern emerges" skeleton for many days running, sign-offs collapsed into "Keep your X and your Y", intros reused the same two-move template, and radio-noun banks ("signal", "dispatch", …) saturated the corpus.

Root causes in the old prompt path:

1. Schema / system instructions that **prescribed** a checklist outro (synthesis → pattern → farewell) won over softer "vary your phrasing" prose.
2. No memory of prior episodes' openings and sign-offs — only story coverage via the Curation Ledger.
3. No structural variety independent of the daily persona rotation.

## Guidance

The script stage now stacks three layers (all in `src/script.ts` + `src/ledger.ts`):

| Layer | Mechanism | Job |
|---|---|---|
| Daily moves | `INTRO_MOVES` / `OUTRO_MOVES` via salted `stableHash(date)` | Prescribe a *different structural shape* each day (independent of persona) |
| Style snippets | `loadRecentStyleSnippets(today, 8)` from `*.transcript.txt` | Feed last ~8 intro openers, outro openers, and sign-offs as **RECENTLY USED — do not reuse** |
| Validators | Hard-fail outro molds + soft `BANNED_SCRIPT_PHRASES` | Reject recycled constructions; 3 attempts per model so a mold hit can re-roll |

**Do**

1. Keep every hard-fail regex mirrored by an explicit forbid sentence in the system prompt — otherwise a compliant model can still hit the validator.
2. Include `recentStyle` in the script `STAGE_CACHE_DIR` key (already done in `src/index.ts`) so a change in anti-repetition examples invalidates a cached script.
3. Prefer Sonnet (and Gemini) over `openai/gpt-4o-mini` for voice-rule adherence — mini is last in `DEFAULT_SCRIPT_MODELS` because it ignores much of the voice block.
4. Treat style memory as **non-blocking**: missing transcripts → `[]` → cold-start prose (same posture as the Curation Ledger).

**Do not**

- Hard-fail on constructions the prompt does not explicitly forbid (false positives burn attempts).
- Confuse style snippets with Follow-up / Suppression — those are about *stories*, not *phrasing*.
- Cap radio-metaphor nouns only in the prompt while still baking them into persona delivery text (both were detoxed together).

## Example

```bash
# Replay a published day's curation through the current prompt (prints script; no TTS)
EPISODE_DATE=2026-08-07 npm run diagnose:script-model
```

`scripts/diagnose-openrouter-script.ts` loads that date's sidecar curation records when present, injects `loadRecentStyleSnippets`, and logs the generated script for prompt A/B. Without `EPISODE_DATE` (or without a matching sidecar), it uses synthetic diagnostic clusters.

## Related

- Code: `src/script.ts` (`INTRO_MOVES`, `OUTRO_MOVES`, `SEGMENT_SHAPES`, `BANNED_*`, `assertNoWornPhrases`, validators), `src/ledger.ts` (`loadRecentStyleSnippets`, `buildRecentPhraseProfile`), `src/voice.ts` (`HOST_IDENTITY`, `VOICE_EXEMPLARS`), `src/earEdit.ts`, `src/ngrams.ts`, `src/index.ts` (wire + stage-cache key)
- Tests: `test/script.voice.test.ts` (renamed from `test/script.persona.test.ts`), `test/script.style.test.ts`, `test/ledger.test.ts` (style snippet + phrase-profile parsing), `test/earEdit.test.ts`, `test/ngrams.test.ts`, `test/styleMetrics.test.ts`
- Concepts: Style snippets, Intro / outro move, Outro mold validator, Host identity, Voice exemplars, Emphasis budget, Segment shape, Phrase tripwire, Ear edit, Delivery hint, Style report in `CONCEPTS.md`

## Addendum (2026-08-14): persistent host, phrase tripwire, ear edit

The three-layer model above still holds, but two more layers now stack on top of it, and one of the original three changed shape.

| Layer | Mechanism | Job |
|---|---|---|
| Daily moves | `INTRO_MOVES` / `OUTRO_MOVES` via salted `stableHash(date)` | Prescribe a *different structural shape* each day for the open/close; `SEGMENT_SHAPES` (salted by date + segment index) does the same job per story segment |
| Style snippets | `loadRecentStyleSnippets(today, 8)` from `*.transcript.txt` | Feed last ~8 intro openers, outro openers, and sign-offs as **RECENTLY USED — do not reuse** |
| Phrase tripwire | `buildRecentPhraseProfile` (`src/ledger.ts`) + `assertNoWornPhrases` (`src/script.ts`) | Count 3/4-word phrases by *episode coverage* across the last 8 transcripts; surface ≥3-episode phrases as worn-out in the prompt, hard-reject ≥4-episode phrases so the attempt re-rolls |
| Validators | Hard-fail outro molds + soft `BANNED_SCRIPT_PHRASES` | Reject recycled constructions; 3 attempts per model so a mold hit can re-roll |
| Ear edit | `src/earEdit.ts`, a non-blocking post-script pass | Mechanically enforce the emphasis budget (cut warm-up sentences, break same-shape runs, collapse unearned triads) on a script the writer already produced |

What changed:

- **The five rotating `DAILY_PERSONAS` are retired.** There is one persistent host (`src/voice.ts` — `HOST_IDENTITY`, `VOICE_EXEMPLARS`), so "vary the persona" is no longer a lever anyone should reach for; voice consistency now comes from identity + exemplars, and prose variety comes from the layers in the table above.
- **`BANNED_SCRIPT_PHRASES` is frozen** at a small set of timeless entries (the comment above it in `src/script.ts` says so). Do not add entries when a new AI-sounding tic shows up — that drift is the Phrase tripwire's job; it catches phrases statistically from what the show has actually said recently instead of waiting for someone to notice and enumerate them.
- **The mirror-sentence rule (Do #1 above) now also covers `assertNoWornPhrases`**: the system prompt's "never reuse RECENTLY USED constructions or worn-out phrasing" sentence is the required mirror for that validator, same as every outro-mold regex needs its own forbid sentence.
- **`npm run style:report`** (`scripts/style-report.ts`) prints per-episode sentence-length variance, antithesis/triad/metadiscourse counts, and top repeated n-grams across recent transcripts — use it to check whether a prompt change actually moved the register, not just whether it reads better on one sample episode.
