---
title: Strict LLM structured-output schemas — nullable+required, and anyOf for nullable enums
date: 2026-10-12
category: docs/solutions/best-practices
module: curate / script / LLM structured output
problem_type: best_practice
component: src/curate.ts, src/script.ts, src/earEdit.ts
severity: medium
applies_when:
  - Adding or changing a JSON schema sent with strict structured output to an LLM
  - Adding an optional or nullable field to an LLM response schema
  - Combining `enum` with nullability on a field (especially Anthropic / Claude routes)
  - Pointing a pipeline stage at a different model or provider
tags: [llm, structured-outputs, json-schema, openai, openrouter, anthropic, strict-mode, curate, script]
---

# Strict LLM structured-output schemas — nullable+required, and anyOf for nullable enums

## Context

Two separate schema traps have broken or nearly broken this unattended pipeline:

1. **OpenAI strict completeness** (ledger / curate). An optional `followUp` object was added to the curate response schema as a property *not* listed in `required`, under `strict: true` with `additionalProperties: false`. That shape is fine on OpenRouter→Claude today but is rejected the moment the schema hits a native OpenAI endpoint.
2. **Anthropic nullable + enum** (script / ear edit, 2026-10-05). Segment `delivery` used `type: ["string", "null"]` plus `enum: [...hints, null]`. Every Anthropic structured-output route rejected it with `Enum value 'measured' does not match declared type`, so Sonnet never wrote a script or ear edit. Null must be its own `anyOf` branch; the enum stays on the string branch only.

Provider routing makes both traps easy to miss:

- **`curate`** is hardcoded to OpenRouter and routes to Anthropic. It does **not** enforce OpenAI's strict-completeness rule, so a non-conformant schema can pass every curate test.
- **`script` / `earEdit`** default to Anthropic via OpenRouter (`OPENROUTER_SCRIPT_MODEL`) and can also send `openai/...` **directly** to the native OpenAI API when `OPENAI_API_KEY` is set. A schema must therefore satisfy **both** Anthropic's validator and OpenAI strict mode when it is shared (`SCRIPT_RESPONSE_SCHEMA` is reused by ear edit).

## Guidance

### 1. Optional fields: nullable + required (OpenAI strict)

When sending a JSON schema with `strict: true` and `additionalProperties: false`, **every property under that object must appear in `required`**. Express "optional" by making the field nullable, not by omitting it from `required`:

- Add the field to `required`.
- For object/string fields **without** an `enum`, `type: ["object", "null"]` / `["string", "null"]` is fine.
- Handle `null` at the parse boundary — treat it as "absent" when normalizing into the domain object.

### 2. Nullable enums: use `anyOf` (Anthropic)

**Do not** put an `enum` on a `type: ["string", "null"]` union (and do not list `null` inside the enum alongside string values). Anthropic's structured-output validator rejects that shape.

Use `anyOf` so null is a separate branch:

```jsonc
"delivery": {
  "anyOf": [
    { "type": "string", "enum": ["measured", "warm", "dry", "serious", "curious", "brisk", "flat"] },
    { "type": "null" }
  ]
}
```

Pinned in `SCRIPT_RESPONSE_SCHEMA` (`src/script.ts`); ear edit reuses the same segment schema. Covered by `test/script.voice.test.ts`.

Plain nullable strings without an enum (for example segment `stance`) may keep `type: ["string", "null"]`.

### 3. Schemas are not portable across stages by default

Confirm which provider/endpoint each stage actually targets before reusing a schema. Strict-mode and enum-union rules are provider-specific.

## Why this matters

A schema that only one provider rejects is the worst kind of latent defect for an unattended pipeline: it passes local tests on the lenient path, then fails 100% of weekday runs the instant the strict path is taken — a model swap, a new `OPENAI_API_KEY`, or copying the schema into script/ear edit. The failure is a request-time 400 that aborts the whole stage (and, for Anthropic enum+union, every fallback that still hits Claude).

## When to apply

- Any time you add or edit a property in an LLM structured-output schema.
- Whenever you introduce an "optional" or nullable field — especially with `enum`.
- Before reusing a schema across pipeline stages, or repointing a stage at a new model/provider.

## Examples

### Optional object omitted from `required` (OpenAI strict)

Before — rejected by native OpenAI strict mode:

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

After — nullable + required:

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

### Nullable enum (Anthropic)

Before — aborts every Anthropic script/ear-edit call:

```jsonc
"delivery": {
  "type": ["string", "null"],
  "enum": ["measured", "warm", "dry", "serious", "curious", "brisk", "flat", null]
}
```

After — null is its own `anyOf` branch (see Guidance §2).

## Related

- Code: `RESPONSE_SCHEMA` in `src/curate.ts`; `SCRIPT_RESPONSE_SCHEMA` / ear-edit reuse in `src/script.ts`, `src/earEdit.ts`.
- Tests: `test/script.voice.test.ts` (delivery `anyOf` shape).
- Delivery allow-list: `SEGMENT_DELIVERY_HINTS` / `docs/solutions/best-practices/input-output-safety-limits.md`.
- Provider routing: `AGENTS.md` → Environment variables (`OPENROUTER_SCRIPT_MODEL`, `OPENAI_API_KEY`).
