---
title: Thread host stance and curator specifics across episodes without inventing facts
date: 2026-08-31
category: docs/solutions/best-practices
module: curate / script / publish / ledger
problem_type: best_practice
component: src/curate.ts, src/script.ts, src/publish.ts, src/ledger.ts
severity: medium
applies_when:
  - Debugging why a follow-up ignores yesterday's on-air judgment
  - Changing CurationRecord / EpisodeSegment / StoryCluster fields
  - Tuning curator extraction (specifics) or prior-coverage prompt formatting
  - Investigating empty specifics or missing stance on a sidecar
tags: [curate, script, stance, specifics, follow-up, ledger, sidecar]
---

# Thread host stance and curator specifics across episodes without inventing facts

## Context

Two additive fields feed the writer's prompt with *grounded* material:

1. **Specifics** — short, article-grounded details extracted at curation time so the script narrates from figures, named actors, and quotes instead of paraphrasing the headline.
2. **Stance** — the host's one-sentence on-air judgment for a segment, persisted on the sidecar so a later follow-up can explicitly revisit the prior take.

Both landed with the voice overhaul (Phases 5–6). Glossary entries live in `CONCEPTS.md`; this note is the end-to-end data-flow runbook.

## Data flow

```
fetch (longer excerpts)
  → curate (specifics[]; followUp.priorStance from ledger "take:")
  → script (writes stance? + uses specifics / priorStance in the prompt)
  → earEdit (rewrites chunks only; forces original stance/delivery through)
  → publish (sidecar curation[]: stance from segment i, specifics from cluster i)
  → next day: ledger.loadRecentCoverage → curate prior-coverage "| take: …"
```

| Stage | What happens |
|---|---|
| Fetch | Excerpt length is ~900 characters so the curator has enough raw text to pull specifics (`src/fetch.ts`). |
| Curate | Prompt asks for **3–5** specifics per cluster (figures with a comparison, named people/orgs with roles, one short verbatim quote). `normaliseCluster` trims, drops blanks, **caps at 6**, and omits the field when empty/malformed. Follow-ups copy `priorStance` from the ledger line's `take:` (or null). |
| Prior-coverage block | `buildPriorCoverageBlock` appends ` \| take: <stance>` (stance excerpt capped at 100 chars; whole line at 300). |
| Script | User prompt injects a `Specifics:` bullet list and, for follow-ups, `Your prior take: "…"`. Schema requires nullable `stance` / `delivery`; `normalizeScriptResponse` strips blank/null values so absent stays absent. |
| Ear edit | `mergeEarEdit` takes edited **chunks** only. `stance`, `delivery`, `sourceUrls`, and titles are forced from the original script segment — an edit cannot invent or drop a take. |
| Publish | Positional join: aired cluster `i` ↔ segment `i` (enforced by script validation). Sidecar `curation[i].stance` ← `episode.segments[i].stance`; `curation[i].specifics` ← `cluster.specifics`. |
| Ledger | `loadRecentCoverage` rehydrates those records for the next curate window (`[today − windowDays, today)`). |

**Delivery hints are not stance.** `delivery` is a 3–6 word TTS performance note, script→tts only, never written to the sidecar.

## Guidance

**Do**

1. Keep stance **nullable / additive-optional** on older sidecars — absence means "no take," not an error.
2. When adding fields to `CurationRecord`, treat them as additive: old JSON without the key must still load.
3. Trust the positional cluster↔segment join; do not re-key by title at publish time.
4. Prefer fixing empty specifics upstream (excerpt length, curator prompt) over inventing filler in the script stage.

**Do not**

- Persist `delivery` onto the sidecar (it is transient by design).
- Let ear edit rewrite `stance` — `mergeEarEdit` must keep forcing the original.
- Confuse Follow-up (story continues) with Stance memory (what the host said last time). Both ride `followUp`, but only `priorStance` carries the take.
- Enumerate new banned phrases when a follow-up re-argues from scratch — check whether `priorStance` / ledger `take:` is actually reaching the curator prompt first.

## Example

Inspect yesterday's take and today's follow-up wiring:

```bash
# Sidecar: did the aired segment record a stance + specifics?
jq '.curation[] | {canonicalKey, stance, specifics}' docs/episodes/YYYY-MM-DD.json

# Script prompt A/B with that day's curation (needs OPENROUTER_API_KEY)
EPISODE_DATE=YYYY-MM-DD npm run diagnose:script-model
```

Unit coverage to keep green when touching this path:

- `test/curate.prompt.test.ts` / `test/curate.selection.test.ts` — prior-coverage `take:` + specifics normalize
- `test/script.threading.test.ts` / `test/script.voice.test.ts` — priorStance in user prompt; nullable stance/delivery schema
- `test/earEdit.test.ts` — stance/delivery forced from original
- `test/publish.curation-record.test.ts` / `test/ledger.test.ts` — round-trip + ledger passthrough

## Related

- Concepts: Stance memory, Specifics, Follow-up, Curation Ledger, Ear edit, Delivery hint in `CONCEPTS.md`
- Code: `src/curate.ts`, `src/script.ts`, `src/earEdit.ts`, `src/publish.ts`, `src/ledger.ts`, `src/types.ts`, `src/fetch.ts`
- Sibling: `docs/solutions/best-practices/script-anti-repetition-style-memory.md` (prose variety; not story memory)
