---
date: 2026-06-17
type: feat
status_note: progress is derived from git by ce-work, not stored here
---

# feat: Story-velocity ranking for curation

## Summary

Give curation a sense of *momentum*: track how fast a story is gaining independent coverage across days and feed that velocity into ranking, so an accelerating early-signal story can outrank a large-but-saturated one — and a sharply accelerating story can resurface even after M1 would suppress it as already-covered. Velocity is recorded as the distinct-publisher set per scored story per day, computed over the rolling window, and surfaced to the curate LLM as a labeled signal (consistent with how M1 prior-coverage and M14 interest-profile already steer scoring). Additive and behavior-neutral on cold start.

---

## Problem Frame

Curation scores each day's clusters in isolation. Importance correlates with cluster size and source diversity *today* (arXiv 2402.10302), but a snapshot can't distinguish a story that's exploding (3 outlets → 12 overnight) from one that peaked yesterday and is now coasting. The epidemiology analogy: prevalence (total size) and the reproduction number (rate of new spread) are different signals, and the rate is what flags a developing story early.

The cross-episode ledger (M1) records per-aired-story metadata but **no source breadth over time**, so velocity is uncomputable today. Worse, M1 records *aired* stories only — a story rising below the air bar yesterday leaves no trace, so aired-only history is blind to pre-breakout acceleration. M3's curation report (PR #32) persists the **full scored cluster list** (aired + dropped), which is the correct substrate for tracking a story's growth before it breaks out.

---

## Dependencies / Assumptions

- **Hard dependency on M3 (PR #32 — curation observability).** Velocity needs per-day source breadth for *all* scored clusters, not just aired ones. M3 persists the full scored list (`curationReport`); this plan extends that record with publisher data and reads it back across days. Sequence this work **after M3 merges to main**. (Fallback if M3 is abandoned: a reduced aired-only version on M1's `curation` field — see Alternatives.)
- Builds on M1 (ledger/threading) and M14 (interest-profile weighting); must not regress either.
- No new datastore — same JSON-sidecar + rolling-window convention as M1/M3.

---

## Key Technical Decisions

**KTD1. Record the distinct publisher set per scored story per day.** Extend M3's `ScoredCluster` with `publishers: string[]` (deduped publisher names from the cluster's sources), persisted in `curationReport`. Distinct publishers (not a raw count) let velocity measure *new independent outlets joining* across days — true spread, not the same outlets re-reporting. Optional field; sidecars without it are treated as no-history (graceful, like M1).

**KTD2. Velocity = growth of the distinct-publisher set across the rolling window.** For a recurring `canonicalKey`, compare the publisher set seen in recent days against earlier days to derive new-publishers-per-day (and whether that rate is rising). Computed in a dedicated module from the scored-cluster history. Cold start / single-day history → no velocity (signal omitted entirely).

**KTD3. Surface velocity as a labeled signal in the curate prompt — the LLM weighs it.** Mirror M1's prior-coverage block and M14's interest profile: inject a compact "story momentum" block naming which recurring stories are accelerating. No numeric mutation of the importance score and no rigid formula — consistent with the existing LLM-judged selection. Behavior-neutral when the block is empty.

**KTD4. Velocity can resurface a suppressed story.** Extend M1's existing "always surface a major escalation" instruction with velocity as its concrete trigger: a sharply accelerating story should air as a follow-up even if M1 would otherwise suppress it as already-covered. Expressed as model guidance (e.g., "gaining several new independent outlets per day"), not a hard numeric gate — same posture as KTD3.

**KTD5. Surface velocity in M3's observability.** Add the velocity signal (and the per-cluster publisher count) to M3's `curationReport` and the `curate.report` log, so tuning velocity is auditable the same way M3 made selection auditable.

---

## High-Level Technical Design

Velocity reads the same rolling sidecar history M1 uses, but over M3's full scored list, and emits a prompt signal rather than mutating scores:

```mermaid
flowchart TD
  S[(episode sidecars<br/>curationReport.clusters<br/>+ publishers[] per cluster)]
  S -->|"read rolling window (U2)"| V[velocity: new distinct<br/>publishers/day per canonicalKey]
  V -->|"momentum block in prompt (U3)"| C[curate LLM scoring]
  V -->|"resurface guidance (U4)"| C
  C -->|"scored clusters incl. publishers (U1)"| R[curationReport]
  R -->|persist| S
  V -.->|"surface in report + log (U5)"| R
```

Directional; the unit specs are authoritative.

---

## Implementation Units

### U1. Record per-cluster publisher set in the scored history

**Goal:** every scored cluster persists the distinct publishers covering it, so cross-day velocity has data.
**Dependencies:** M3 (PR #32) merged.
**Files:** `src/types.ts` (add `publishers: string[]` to `ScoredCluster`), `src/curate.ts` (populate in `scoreAndSelect` from each cluster's `sources`, deduped), `src/publish.ts` (persists `curationReport` already — confirm publishers ride along), `test/curate.report.test.ts` (extend).
**Approach:** derive `publishers` by deduping `sources[].publisher` per cluster. Keep it optional/backward-compatible. No change to selection behavior.
**Test scenarios:** publishers deduped and present on every scored cluster; empty-sources cluster → empty array (no throw); existing M3 report assertions still pass (behavior-neutral).
**Verification:** a written sidecar's `curationReport.clusters[].publishers` reflects the deduped publishers; build + report tests green.

### U2. Velocity computation module

**Goal:** compute per-`canonicalKey` velocity (new distinct publishers/day, and whether accelerating) from the rolling scored-cluster history.
**Dependencies:** U1.
**Files:** `src/velocity.ts` (new), `src/ledger.ts` (add a reader for `curationReport.clusters` history across the window, alongside the existing `loadRecentCoverage`; or a sibling `loadScoredHistory`), `test/velocity.test.ts` (new).
**Approach:** for each recurring key, union publishers by day, compute new-publishers-per-recent-day vs. earlier baseline; expose a small per-key velocity descriptor (e.g., `{ canonicalKey, newPublishersRecent, accelerating: boolean }`). Non-blocking: missing/corrupt sidecars skipped (reuse M1's tolerant read posture). Single-day or no history → empty result.
**Test scenarios:** rising publisher set across days → accelerating true; flat/saturated set → accelerating false; brand-new key (no history) → omitted; corrupt sidecar in range skipped without throw; publisher dedup across days (same outlet re-reporting doesn't count as new).
**Verification:** velocity descriptors match hand-computed expectations on fixture sidecars in a temp dir.

### U3. Surface velocity as a momentum signal in the curate prompt

**Goal:** the curate LLM sees which recurring stories are accelerating and can rank them up.
**Dependencies:** U2.
**Files:** `src/curate.ts` (load velocity for the window like prior coverage; build a compact momentum block in the user/system prompt), `test/curate.prompt.test.ts` (extend) or `test/curate.velocity.test.ts` (new).
**Approach:** pure prompt-block builder (mirror `buildPriorCoverageBlock`/`buildInterestProfileBlock`): when velocity data exists, list accelerating stories; when empty, omit the block (prompt byte-identical to today). Add a system-prompt instruction to weigh momentum in scoring.
**Test scenarios:** momentum block present with accelerating keys when data exists; absent when empty (behavior-neutral); system prompt carries the weigh-momentum instruction; the block stays compact (capped, like M1's prior-coverage block).
**Verification:** prompt builders unit-tested without a live LLM; behavior-neutral equality when no velocity.

### U4. Velocity-driven resurfacing of suppressed stories

**Goal:** a sharply accelerating story airs as a follow-up even when M1 would suppress it as already-covered.
**Dependencies:** U3.
**Files:** `src/curate.ts` (extend the existing suppress/"always surface a major escalation" instruction to name velocity as the trigger), `test/curate.prompt.test.ts`/`test/curate.velocity.test.ts` (extend).
**Approach:** model-guidance only (no hard numeric gate), consistent with KTD3 — extend the suppression rule text so an accelerating recurrence is treated as a developed follow-up. Reuses M1's `followUp` mechanism for the framing.
**Test scenarios:** system prompt instructs that an accelerating story overrides suppression; non-accelerating recurrences still suppress per M1 (no regression to M1's suppress rule wording).
**Verification:** prompt-content assertions; M1 threading/suppression tests still pass.

### U5. Surface velocity in observability

**Goal:** velocity is auditable alongside M3's curation report.
**Dependencies:** U2, M3.
**Files:** `src/curate.ts` (add velocity to the `curate.report` log and to `curationReport` per-cluster where present), `src/types.ts` (optional velocity fields on the report), `test/curate.report.test.ts` (extend).
**Approach:** additive fields; absent when no velocity. Keep the M1 `curation` (ledger-consumed) field untouched.
**Test scenarios:** report/log include velocity for accelerating keys; absent on cold start; M3 report tests still pass.
**Verification:** report round-trip carries velocity; logs show momentum counts.

---

## Scope Boundaries

**In scope:** publisher-set recording (U1), velocity computation (U2), prompt momentum signal (U3), velocity-driven resurfacing (U4), observability (U5).

**Deferred to Follow-Up Work:** none required for a working feature.

**Not in scope:** intra-day (hourly) velocity — the pipeline runs once per weekday, so velocity is day-granular; sub-day acceleration would need the event-driven cadence idea (M22, not pursued). No numeric score-mutation formula (KTD3 chose prompt-signal).

---

## Alternatives Considered

- **Aired-only substrate (build on M1, not M3).** Record publishers only for aired stories on M1's `curation` field. Removes the M3 dependency, but is blind to pre-breakout acceleration (a story must already have aired to be tracked) — which undercuts the core "catch it early" goal. Rejected as the primary design; viable fallback only if M3 is abandoned.
- **Deterministic velocity score boost.** Add a computed boost to importance before selection. Predictable/testable but a rigid formula the LLM doesn't mediate, inconsistent with M1/M14's prompt-signal pattern, and harder to tune. Rejected per KTD3; the velocity number is still computed (U2) and could feed a boost later if the prompt-signal proves weak.

---

## Risks & Dependencies

- **M3 sequencing.** This work is gated on M3 (PR #32). If M3's `ScoredCluster`/`curationReport` shape changes in review, U1/U5 must track it. Mitigation: land after M3 merges; keep `publishers` additive.
- **Sparse history / cold start.** Most stories won't recur; velocity is meaningful only for the minority that do. Behavior-neutral design (empty signal omitted) means no downside when there's nothing to say.
- **Publisher-name normalization.** The same outlet under varying publisher strings would undercount "new" outlets. Mitigation: dedupe case-insensitively/trimmed; note exact normalization as an implementation-time detail.
- **Prompt budget.** The momentum block competes with M1's prior-coverage block and M14's profile for curate prompt space; keep it capped (reuse M1's cap posture). Touches cost-per-episode.

---

## Sources / Research

- In-session grounding (built this session): `src/curate.ts` (`scoreAndSelect`, `selectStoryClusters`, prompt builders), `src/ledger.ts` (`loadRecentCoverage`), `src/types.ts` (`CurationRecord`, `ScoredCluster`/`CurationReport` from M3), `src/publish.ts` (sidecar persistence).
- Origin idea: `docs/ideation/2026-06-17-open-ideation.html` (story-velocity / R-number ranking).
- External basis: news importance correlates with cluster size + source entropy (arXiv 2402.10302); R-number / rate-vs-prevalence analogy from epidemiology.
- Related shipped features: M1 (memory/threading), M3 (curation report), M14 (interest profile).
