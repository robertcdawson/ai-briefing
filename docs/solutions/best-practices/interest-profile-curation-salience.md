---
title: Interest profile nudges curation importance without filtering major news
date: 2026-09-07
category: docs/solutions/best-practices
module: curate / interests
problem_type: best_practice
component: src/interests.ts, src/curate.ts
severity: low
applies_when:
  - Retuning which story types the show leans toward
  - Debugging why an off-theme landmark story still aired (or why a niche story ranked high)
  - Setting INTEREST_PROFILE locally or in GitHub Actions
  - Disabling personalization for an A/B curate run
tags: [curate, interest-profile, salience, prompt, personalization]
---

# Interest profile nudges curation importance without filtering major news

## Context

Curation used to score every day's articles as if for a generic AI audience. The show has one listener with known topical leanings, so `src/interests.ts` injects a **LISTENER INTEREST PROFILE** block into the curate system prompt. That block is a weighting nudge on importance scores — not a hard filter.

Without the documented major-news floor, a personalized profile becomes a filter bubble: landmark frontier / safety / policy news gets buried because it is "off theme."

## How it works

```
getInterestProfile()
  → buildSystemPrompt(profile) / buildInterestProfileBlock(profile)
  → curate LLM call (importance scoring)
```

| Input | Behavior |
|---|---|
| `INTEREST_PROFILE` unset | Use committed `DEFAULT_INTEREST_PROFILE` in `src/interests.ts`. |
| `INTEREST_PROFILE` set to non-empty text | Override the default for that process only. |
| `INTEREST_PROFILE` set to `""` / whitespace | Disable personalization: `buildInterestProfileBlock` returns `""` and the prompt is byte-identical to the pre-M14 shape. |

The injected block tells the model to nudge scores **up** for profile fit, treat fit as one factor among others, and **never bury** a genuinely major AI development for being off-theme (`REGARDLESS` / "never as a filter" wording in `buildInterestProfileBlock`).

## Guidance

**Do**

1. Edit `DEFAULT_INTEREST_PROFILE` when the standing show lean should change for every run (including CI).
2. Use `INTEREST_PROFILE` for one-off local experiments or temporary Actions overrides.
3. Keep the major-news floor wording if you rewrite the block — unit tests in `test/curate.interests.test.ts` assert it.

**Do not**

- Treat the profile as a topic allow-list. Suppression and follow-up logic still come from the Curation Ledger; the profile only biases scoring.
- Expect an Actions variable named `INTEREST_PROFILE` to apply unless `.github/workflows/daily.yml` forwards `vars.INTEREST_PROFILE` into the pipeline step env (it does).

## Example

```bash
# Temporary local lean (does not edit the committed default)
INTEREST_PROFILE='Lean hard toward developer tooling and eval harnesses.' npm start

# Disable personalization for one local run
INTEREST_PROFILE= npm start
```

Standing retune: edit the template string in `src/interests.ts`, run `npm run test:unit -- --test-name-pattern=Interest|interest`, and commit.

## Related

- Glossary: Interest profile in `CONCEPTS.md`
- Tests: `test/curate.interests.test.ts`
- Sibling memory features: `docs/solutions/best-practices/stance-memory-and-curator-specifics.md`
