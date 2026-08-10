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

- Code: `src/script.ts` (`INTRO_MOVES`, `OUTRO_MOVES`, `BANNED_*`, validators), `src/ledger.ts` (`loadRecentStyleSnippets`), `src/index.ts` (wire + stage-cache key)
- Tests: `test/script.style.test.ts`, `test/ledger.test.ts` (style snippet parsing)
- Concepts: Style snippets, Intro / outro move, Outro mold validator in `CONCEPTS.md`
