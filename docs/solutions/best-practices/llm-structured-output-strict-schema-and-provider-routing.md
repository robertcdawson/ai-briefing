---
title: Strict LLM structured-output schemas must make optional fields nullable+required, and provider routing differs per stage
date: 2026-06-17
category: docs/solutions/best-practices
module: curate / LLM structured output
problem_type: best_practice
component: service_object
severity: medium
applies_when:
  - Adding or changing a JSON schema sent with strict structured output to an LLM
  - Adding an optional field to an LLM response schema
  - Pointing a pipeline stage at a different model or provider
tags: [llm, structured-outputs, json-schema, openai, openrouter, strict-mode, curate]
---

# Strict LLM structured-output schemas must make optional fields nullable+required, and provider routing differs per stage

## Context

While reviewing the cross-episode memory ledger feature, a new optional `followUp` object was added to the curate response schema (`RESPONSE_SCHEMA` in `src/curate.ts`) as a property that was *not* listed in the object's `required` array, under `strict: true` with `additionalProperties: false`. It worked in testing and looked correct. Multiple reviewers flagged it as a latent break: it is fine on the path the code uses today, but would be rejected the moment the schema reached a native OpenAI endpoint.

Two facts about this repo made the risk non-obvious:

- **Provider routing differs per pipeline stage.** `curate` is hardcoded to OpenRouter (its OpenAI client is constructed with `baseURL` pointing at `openrouter.ai` and it throws without `OPENROUTER_API_KEY`), and routes to an Anthropic model. But `script`/TTS can route an `openai/...` model **directly to the native OpenAI API** when `OPENAI_API_KEY` is set (see `AGENTS.md` → `OPENROUTER_SCRIPT_MODEL`). So a schema that is safe in `curate` today is not automatically safe if copied into a stage that can hit OpenAI directly, or if `curate` is ever repointed.
- **OpenRouter→Claude does not enforce OpenAI's strict-completeness rule**, so the non-conformant schema passed silently in tests.

## Guidance

When sending a JSON schema to an LLM with strict structured output, **every property declared under an object with `additionalProperties: false` must appear in that object's `required` array.** Express an "optional" field by making it nullable, not by omitting it from `required`:

- Add the field to `required`.
- Give it a nullable type: `type: ["object", "null"]` (or `["string", "null"]`, etc.).
- Handle the `null` case at the parse boundary — treat `null` as "absent" when normalizing the model's response into your domain object.

Also: **do not assume a structured-output schema that works in one pipeline stage is portable to another.** Confirm which provider/endpoint each stage actually targets before reusing a schema, because strict-mode enforcement is provider-specific.

## Why This Matters

A schema that only the strictest provider rejects is the worst kind of latent defect for an unattended pipeline: it passes every local test (which use the lenient path), then fails 100% of runs the instant the strict path is taken — a model swap, a new `OPENAI_API_KEY`, or copying the schema into a stage that routes to OpenAI. The failure is a request-time 400 that aborts the whole stage, not a degraded result. Making optionals nullable+required is behavior-neutral on the lenient path and forward-safe on the strict one, so there is no reason not to do it by default.

## When to Apply

- Any time you add or edit a property in an LLM structured-output schema.
- Whenever you introduce an "optional" field to a model response.
- Before reusing a schema across pipeline stages, or repointing a stage at a new model/provider.

## Examples

Before — optional field omitted from `required` (rejected by native OpenAI strict mode):

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "canonicalKey": { "type": "string" },
    "followUp": {
      "type": "object",
      "properties": { "priorDate": { "type": "string" }, "priorFraming": { "type": "string" } },
      "required": ["priorDate", "priorFraming"],
      "additionalProperties": false
    }
  },
  "required": ["canonicalKey"]   // followUp missing -> 400 under strict mode
}
```

After — nullable + required (portable across providers):

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "canonicalKey": { "type": "string" },
    "followUp": {
      "type": ["object", "null"],
      "properties": { "priorDate": { "type": "string" }, "priorFraming": { "type": "string" } },
      "required": ["priorDate", "priorFraming"],
      "additionalProperties": false
    }
  },
  "required": ["canonicalKey", "followUp"]
}
```

Parse boundary — treat `null` (and malformed objects) as absent when normalizing:

```ts
// only carry followUp when it is a complete, non-null object
if (raw.followUp && typeof raw.followUp.priorDate === "string" && raw.followUp.priorDate.trim()
    && typeof raw.followUp.priorFraming === "string" && raw.followUp.priorFraming.trim()) {
  result.followUp = raw.followUp;
}
```

## Related

- Feature: cross-episode memory ledger (`src/curate.ts`, `src/ledger.ts`).
- Provider routing reference: `AGENTS.md` → Environment variables (`OPENROUTER_SCRIPT_MODEL`, `OPENAI_API_KEY`).
