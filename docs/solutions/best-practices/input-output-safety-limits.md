---
title: Bound RSS, prompts, and TTS requests before paid synthesis
date: 2026-10-05
category: docs/solutions/best-practices
module: inputLimits / promptData / tts / speakerProfiles
problem_type: best_practice
component: src/inputLimits.ts, src/promptData.ts, src/tts.ts, src/speakerProfiles.ts
severity: medium
applies_when:
  - Changing fetch, curate, script, or TTS size assumptions
  - Debugging a fail before TTS that mentions budget / byte limit / request budget
  - Adding fields from RSS or model output into LLM prompts
  - Extending per-segment delivery styles
tags: [security, rss, prompt-injection, tts, budgets, untrusted-data]
---

# Bound RSS, prompts, and TTS requests before paid synthesis

## Context

After source-URL validation and private TTS workspaces, the remaining amplification paths were size and trust: oversized RSS bodies, unbounded article fan-out into curation, model output that could explode TTS spend, and free-text delivery notes that could rewrite speech instructions. Commit `394041a` added hard budgets and treated source-derived prompt fields as untrusted data.

These controls reduce **structural** prompt injection and cost amplification. They do **not** claim semantic immunity — fabricated claims still depend on source quality and model behavior.

## How it works

```
RSS Response
  → readFeedText (≤2 MiB decoded)
  → per-feed article cap (40) + field bounds
  → boundedArticles (≤200 total) → curate / script prompts via promptData()
Script / earEdit / stage-cache hit
  → assertNarrationBudget (stories, chunks, chars, words)
TTS
  → assertSpeechBudget (transformed requests, provider max, ≤24 requests, ≤20k chars)
  → sanitizeSegmentDeliveryHint (allow-listed styles only)
```

| Boundary | Limit / rule | Module |
|---|---|---|
| RSS body | 2 MiB decoded bytes; cancel stream when exceeded (works without `Content-Length`) | `readFeedText` |
| Per feed | 40 articles | `MAX_ARTICLES_PER_FEED` in `fetch.ts` |
| Aggregate | 200 articles; skip title >300, source >100, URL >2048, excerpt >900 | `boundedArticles` |
| Script shape | ≤6 stories; ≤24 chunks/part; ≤4000 chars/chunk; ≤18000 chars / 2400 words/episode | `assertNarrationBudget` |
| TTS plan | Re-check narration budget on **transformed** speech text; ≤ provider `maxRequestChars` per request; ≤24 requests; ≤20000 chars total. Fail before the first paid call; never silently truncate | `assertSpeechBudget` |
| Prompt encoding | `promptData` JSON-stringifies values and escapes `<>` / line/paragraph separators so untrusted text cannot open new prompt sections | `src/promptData.ts` |
| Untrusted rule | `UNTRUSTED_DATA_RULE` is prepended in curate, script, and ear-edit prompts | same |
| Specifics | Drop items >200 chars or >15 words (do not shorten quotes); keep ≤6 | `boundedSpecifics` |
| Delivery | Script schema enum = `SEGMENT_DELIVERY_HINTS`; TTS maps only those keys to fixed instruction strings; unknown/legacy free text → section default | `sanitizeSegmentDeliveryHint` |

`assertNarrationBudget` runs on live model output **and** stage-cache hits at the speech boundary, so a cached oversized script cannot bypass the gate.

## Guidance

**Do**

1. Fail closed on budget errors — they are cheaper than a runaway TTS bill.
2. Put new RSS/model strings through `promptData` (or an existing bounded helper) before they enter a prompt.
3. Add delivery styles by extending `SEGMENT_DELIVERY_HINTS` **and** `SEGMENT_DELIVERY_TEXT` together; the script JSON schema enum and the TTS sanitizer must stay aligned.
4. Drop overlong curator specifics rather than truncating mid-quote.

**Do not**

- Treat these guards as “prompt injection solved.”
- Let the model author free-form TTS instruction text.
- Raise caps casually — update `test/inputLimits.security.test.ts` and this doc in the same change.

## Example

```bash
# Unit coverage for budgets + untrusted encoding + allow-listed delivery
npx tsx --test test/inputLimits.security.test.ts test/speakerProfiles.test.ts
```

A local oversized script fails at synthesize with a budget error and never opens a provider connection.

## Related

- Code: `src/inputLimits.ts`, `src/promptData.ts`, `assertSpeechBudget` in `src/tts.ts`, `SEGMENT_DELIVERY_HINTS` in `src/speakerProfiles.ts`
- Tests: `test/inputLimits.security.test.ts`, `test/speakerProfiles.test.ts`, `test/tts.request.test.ts`
- Adjacent URL/workspace guards: `docs/solutions/best-practices/source-url-safety-and-audio-workspaces.md`
- Glossary: Narration budget, Untrusted prompt data, Delivery hint in `CONCEPTS.md`
- Operator summary: README **Input and output safety limits**
