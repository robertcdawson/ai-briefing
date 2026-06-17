---
date: 2026-06-17
topic: feedback-loop
---

# Listener feedback loop (via GitHub Issues)

## Summary

Let the listener steer the show with free-text feedback left from their phone — comments on a single rolling GitHub issue — and have the daily curate step read recent comments and weigh them when scoring stories. No git workflow (no pull/commit/merge), LLM-interpreted, non-blocking. Persistent learning (distilling feedback into the M14 interest profile) is deferred; v1 is a recent-feedback signal.

---

## Problem Frame

The listener consumes the show on an iPhone and can't reliably pull the repo, edit a file, commit, and merge mid-week — so a committed feedback file is the wrong channel. Curation has no feedback path at all today, so the only way to influence the show is editing code. What's needed is a way to drop a quick reaction from a phone, whenever there's a moment during the week, that the next run picks up. The GitHub mobile app commenting on a private repo's issue fits exactly: type a sentence, post, done.

---

## Key Decisions

**KD1. GitHub Issues is the channel.** A single, rolling "Listener feedback" issue the listener comments on from any GitHub client (notably the mobile app). No file edit, commit, or merge. One thread (not an issue per reaction) keeps it to: open app → one issue → comment.

**KD2. Free-text, LLM-interpreted.** Reactions are plain sentences ("too much funding news", "loved the robotics deep-dive", "more on AI-and-jobs"), not structured ratings — lowest phone friction and consistent with the LLM-judged curation.

**KD3. Influence = a recent-feedback signal in the curate prompt.** Recent comments are passed to curate as a labeled signal that nudges story scoring (same pattern as M1 prior-coverage and M14 interest-profile). It weighs, never hard-filters; major news still surfaces (reuse M14's floor posture).

**KD4. Persistent profile-distillation is deferred.** v1 reads recent feedback per run. Folding durable preferences into the M14 interest profile over time is a follow-on, kept out of v1 to stay simple.

**KD5. Non-blocking.** A missing issue, no new comments, or an unreachable GitHub API degrades to today's behavior (no feedback signal) and never fails the run — same posture as the M1 ledger.

---

## Actors

- **Listener** — leaves free-text feedback as issue comments from a phone during the week.
- **Pipeline (curate step)** — reads recent feedback before scoring and weighs it.

---

## Requirements

**Capture**

R1. Feedback is left as comments on a single designated GitHub issue, authored from any GitHub client including the mobile app — no file edit, commit, or merge required.

R2. Comments are free-text; no required structure or format.

**Ingestion**

R3. On each run, the pipeline reads the feedback issue's comments that are new since the last run (not yet reflected in a prior episode).

R4. Ingestion is non-blocking: a missing/closed issue, no new comments, or an unreachable GitHub API yields no feedback signal and the run proceeds normally — never an error.

**Influence**

R5. Recent feedback is passed to curate as a labeled signal weighing story selection/scoring; it nudges rather than filters, and genuinely major news still surfaces regardless of feedback.

**Observability**

R6. The run records what feedback it ingested (e.g., count and comment identifiers) via structured logging, and surfaces it in the curation report where the report exists (M3).

---

## Acceptance Examples

AE1. **Covers R1, R3, R5.** The listener comments "too much funding news" during the week → the next run's curate prompt includes that note and de-emphasizes funding-round stories, while still airing a genuinely major funding story if one breaks.

AE2. **Covers R4.** No new comments on the feedback issue → the run produces a normal episode with no feedback signal and no error.

AE3. **Covers R4.** The GitHub API is unreachable on a run → curate proceeds with no feedback signal; the episode is produced normally.

---

## Scope Boundaries

**Deferred for later:**
- Distilling durable preferences from feedback into the M14 interest profile (persistent learning).
- Structured per-story ratings and feedback trend tracking.

**Not in scope:**
- Capturing reactions from Apple Podcasts (not exportable to us).
- A custom feedback app or UI.

---

## Dependencies / Assumptions

- Read access to the repo's issues: locally via the listener's `gh` auth; in CI the daily workflow's default token can read issues. Wiring issue-read into the daily workflow env is a CI change that needs explicit approval.
- The repo is private and owned by the listener; the GitHub mobile app supports commenting on it.
- Feedback influence quality is LLM-mediated and only fully observable by listening to episodes after feedback is left.

---

## Outstanding Questions (Deferred to Planning)

- **"New since last run" tracking:** how the run determines which comments are unprocessed — comments newer than the last episode's publish time, a stored marker, or a fixed look-back window.
- **Identifying the feedback thread:** a configured issue number (e.g., a `FEEDBACK_ISSUE` env var) vs. a `feedback`-labeled issue lookup.
- **CI auth wiring:** default `GITHUB_TOKEN` (issue read) vs. a dedicated token, and the daily-workflow env change (requires approval).
