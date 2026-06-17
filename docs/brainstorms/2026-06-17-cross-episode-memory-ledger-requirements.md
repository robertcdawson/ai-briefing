---
date: 2026-06-17
topic: cross-episode-memory-ledger
---

# Cross-Episode Memory Ledger & Story Threading

## Summary

Give AI Briefing memory of what it has aired. A rolling ~14-day ledger of covered stories feeds into the curate step so the show stops re-introducing ongoing sagas cold — instead suppressing already-covered stories and threading genuine developments as follow-ups ("we flagged this Monday as a rumor — today it shipped"). The model decides matches and what counts as a real development in-context; no embeddings, no separate matching service.

---

## Problem Frame

`curate` runs cold every day. It scores the last 24 hours of articles against editorial criteria with no knowledge of what previous episodes covered (`src/curate.ts:154-177` — the prompt receives only the raw article list). The `canonicalKey` the curate LLM already produces per cluster (`src/curate.ts:28-30`) is never persisted, validated, or read back, and ~15+ episode sidecars accumulate holding only presentation data (`src/publish.ts:16-29`).

The consequence: a multi-day story can re-land as "new" and burn one of only 1–6 daily slots, and the briefing never delivers the *delta* a daily listener actually values. For a show whose whole pitch is density inside a ~10-minute ceiling, repeating yesterday's news is the most expensive kind of filler. Memory is the difference between a feed and a correspondent who remembers what it already told you.

---

## Key Decisions

**KD1. The model decides matches and development in-context.** Recent ledger entries (canonicalKey, headline, why-it-matters, caveat, date) are passed into the existing curate prompt; the LLM matches recurrences semantically and judges "real development vs. already-covered" itself. This reuses the single curate call, handles reworded recurrences for free, and avoids embeddings or tuned thresholds.

**KD2. Bias toward surfacing when uncertain.** When it's unclear whether a recurrence developed enough, air a short follow-up rather than drop it; a major escalation always surfaces. Safer for a no-human-in-the-loop show where a wrongly-dropped story is invisible — the accepted cost is occasional mild repetition.

**KD3. The ledger is a new persisted artifact, not a separate database.** It records only stories that aired, with the curation fields threading needs. Memory accumulates from rollout forward; the existing episodes are not backfilled because their sidecars lack these fields.

**KD4. A threaded follow-up is a normal story.** It consumes one of the day's 1–6 slots and counts toward the ~10-minute budget — follow-ups compete with fresh stories rather than being bonus content.

**KD5. The ledger is non-blocking.** A missing, empty, or unreadable ledger degrades to today's cold behavior; it never fails an episode. Pipeline reliability is a product track and memory must not become a new failure mode.

---

## Requirements

**Persistence**

R1. Persist a per-aired-story curation record — at minimum `canonicalKey`, `headline`, `whyItMatters`, `caveat`, `importance`, `category`, and episode `date` — so later runs can reason about prior coverage. (Today's sidecar persists only presentation fields.)

R2. Before scoring, `curate` reads a rolling ~14-day window of prior coverage and includes it in the curation prompt.

R3. Memory accumulates from rollout forward; historical episodes are not backfilled.

**Curation behavior**

R4. When a candidate story matches recent prior coverage, the curate step decides in-context whether it materially developed (thread it) or is already-covered (suppress it). Matching is semantic and performed by the model from the supplied ledger context — there is no separate matching mechanism.

R5. When uncertain whether a recurrence developed enough to air, the system prefers a follow-up over suppression; a major escalation always surfaces regardless.

R6. A suppressed story frees its slot for genuinely new items; a threaded follow-up consumes one of the day's 1–6 slots.

**Narration**

R7. A threaded story is delivered as continuity — referencing prior framing (e.g., the earlier caveat as today's setup) rather than re-introduced cold. The script step receives a recurring-vs-new signal plus the prior context needed to narrate the callback. (Today `script` never sees `canonicalKey` — `src/script.ts:291-306`.)

**Reliability & observability**

R8. If the ledger is missing, empty, or unreadable, `curate` proceeds as it does today (cold), producing a normal episode with no threading and no error.

R9. Threading and suppression decisions are recorded via the existing structured logging (`logJson`) so they are inspectable after a run.

---

## Acceptance Examples

AE1. **Covers R4, R7.** A story aired Monday framed as a rumor. Wednesday the same development is confirmed by several sources → it airs Wednesday as a follow-up framed as an update ("the rumor we flagged Monday is now confirmed"), consuming a slot.

AE2. **Covers R4, R6.** A story aired yesterday; today it is merely restated by one outlet with no new substance → it is suppressed, and its slot goes to a new story.

AE3. **Covers R5.** It's genuinely ambiguous whether a recurrence developed → it airs as a short follow-up rather than being dropped.

AE4. **Covers R8.** The ledger file is absent on a run → the episode is produced normally, cold, with no threading and no error raised.

---

## Scope Boundaries

**Deferred for later** (enabled by this ledger, each its own feature):
- Embedding / semantic index for matching — revisit only if in-context matching proves weak.
- Friday "week in review" meta-episode synthesized from the week's ledger.
- Story-velocity (R-number) ranking using cross-day source growth.
- One-tap relevance feedback loop keyed by `canonicalKey`.

**Not in scope:**
- Backfilling curation records for the existing ~15+ episodes.

---

## Dependencies / Assumptions

- `canonicalKey` is already generated by the curate LLM (`src/curate.ts:28-30`) but is currently unvalidated and unpersisted; this feature is the first consumer that persists and reads it back.
- Correctness of threading rests on the curate LLM matching recurrences semantically from the supplied recent-ledger context (KD1). If in-context matching proves unreliable in practice, the deferred embedding index is the fallback.

---

## Outstanding Questions (Deferred to Planning)

- **Storage shape:** extend the existing `EpisodeRecord` sidecar with a curation array vs. a dedicated ledger file. The dossier notes both are viable (`src/publish.ts:16-29`, `:247-260`).
- **Retention:** how the ~14-day curation window interacts with the existing 90-day episode/feed retention.
- **Prompt budget:** how recent-ledger context is summarized into the curate prompt without crowding the article list.

---

## Sources / Research

- Grounding dossier (verbatim shapes, file:line): curate cluster/`canonicalKey` (`src/curate.ts:28-30`), thresholds (`src/curate.ts:11-12`), selection (`src/curate.ts:121-131`), prompt assembly (`src/curate.ts:107-113`, `:154-177`); sidecar `EpisodeRecord` and `loadAllRecords` (`src/publish.ts:16-29`, `:247-260`); script cluster prompt (`src/script.ts:291-306`); episode-date handling (`src/episode-date.ts:1-17`).
- Origin: `docs/ideation/2026-06-17-open-ideation.html`, idea M1.
- External: news importance evolves across days as cluster source-entropy grows (arXiv 2402.10302).
