---
title: Name a transition when independent flags can lie
date: 2026-11-08
category: docs/solutions/best-practices
module: machines / tuneSession
problem_type: best_practice
component: src/machines.ts, src/tuneSession.ts, docs/tune/index.html, src/index.ts, src/verifyDeploy.ts
severity: medium
applies_when:
  - Adding a status flag, boolean, or string that can be true at the same time as another one
  - Changing what "success" means for the healthcheck, the feed, or the tune page
  - Deciding whether a pipeline stage should become a state-machine library
tags: [state, tune-page, healthcheck, verify-deploy, pipeline]
---

# Name a transition when independent flags can lie

## Context

The weekday run is a straight line: preflight, fetch, curate, script, ear edit, TTS, audio, publish. That sequence is a procedure. Several other decisions were not. They were independent flags, and a few of those combinations were false:

- The tune page kept `dirty`, `sha`, two status lines, and a disabled button separately. A save that finished after the listener kept typing set `dirty` back to false, so the page said the morning episode would use text that never left the browser. A 409 wrote "The file changed. Loading the saved version." and the reload then cleared that sentence. Load and save could be in flight together.
- Generation success and "listeners can fetch the episode" were easy to collapse into one ping. They are different actors. The generation job pings success for both a new episode and an already-published skip. The loud feed verifier is the only step that pings fail when the public feed still lacks today's GUID. The quiet first probe must not page.

## Decision

Put a named transition in `src/machines.ts` when two flags can describe a state that cannot happen, or when two actors disagree about success. Leave a straight-line stage as a procedure in `src/index.ts`. Do not add a state-machine runtime. The daily job stays the same sequence of calls.

The tune page is the one interactive machine. `src/tuneSession.ts` is the source. `docs/tune/session.js` is the browser copy, regenerated with `npx tsx scripts/emit-tune-session.ts`. `test/machines.test.ts` fails if the copy drifts.

## What is named

| Decision | States | Where it is used |
|---|---|---|
| Generation outcome | skipped (already published), published, failed | Healthcheck ping in `src/index.ts` |
| Feed poll | pending, live, not_live | `waitForEpisodeLive` |
| Verification ping | none, fail | Loud miss only, in `scripts/verify-deploy.ts` |
| Pages recovery | done, retrigger once, failed | `.github/workflows/daily.yml`, pinned by the step names |
| Interest profile | default, custom, disabled | `getInterestProfile` |
| Cue playback | requested style, or tone when `asset` files are missing | `src/audio.ts` |
| Script model | accept, fallback, exhaust | `src/script.ts` |
| Aired story | new, follow-up | Threading tally. Omission is not a stored "suppressed" state |
| TTS part | whole, chunked | Budget check and synthesis |
| Show config | loaded, or fallback missing / unreadable / invalid | `loadShowConfig` |
| Tune session | idle, loading, ready, saving | `docs/tune/index.html` |

Still procedures: `withRetry`, stage cache, ear-edit keep-or-use (`edited`), TTS provider selection, per-feed fetch, retention. Their branches are already exclusive.

## Guidance

**Do**

- Add a new run outcome as a variant on the existing function, and switch on it at the call site.
- Regenerate `docs/tune/session.js` in the same change as `src/tuneSession.ts`.
- Keep the deploy key out of the verifier. Recovery stays in the workflow.

**Don't**

- Don't ping generation success only after the feed is live. A skip must still count as a successful job, and the quiet probe must stay quiet.
- Don't represent suppression as a third aired-story state. A missing prior key may simply be absent from today's feeds.
- Don't fold the stage list into a library. `GENERATION_STEP_ORDER` is the order `src/index.ts` already logs.

## Related

- `CONCEPTS.md` — Generation outcome, Feed liveness, Tune session
- `docs/solutions/workflow-issues/github-pages-publish-verification.md`
- `docs/solutions/best-practices/show-tune-page.md`
- `docs/solutions/best-practices/interest-profile-curation-salience.md`
