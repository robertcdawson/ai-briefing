import assert from "node:assert/strict";
import test from "node:test";
import {
  DAILY_PERSONAS,
  SCRIPT_RESPONSE_SCHEMA,
  buildSystemPrompt,
  buildUserPrompt,
  selectDailyPersona,
  validateScriptResponse,
} from "../src/script.js";
import type { StoryCluster } from "../src/types.js";

test("selectDailyPersona is stable for the same episode date", () => {
  const first = selectDailyPersona("2026-05-11");
  const second = selectDailyPersona("2026-05-11");

  assert.equal(second.name, first.name);
});

test("selectDailyPersona rotates across dates", () => {
  const selectedNames = new Set(
    [
      "2026-05-11",
      "2026-05-12",
      "2026-05-13",
      "2026-05-14",
      "2026-05-15",
    ].map((date) => selectDailyPersona(date).name),
  );

  assert.ok(selectedNames.size > 1, "date-based selection should vary the delivery persona");
});

test("buildSystemPrompt keeps persona style bounded by factual constraints", () => {
  const persona = DAILY_PERSONAS[0];
  assert.ok(persona, "at least one daily persona must be configured");

  const prompt = buildSystemPrompt(persona);

  assert.match(prompt, new RegExp(`Persona: ${escapeRegExp(persona.name)}`));
  assert.match(prompt, /style lens, not a character bit/);
  assert.match(prompt, /strong opinions/);
  assert.match(prompt, /grounded in the provided facts/);
  assert.match(prompt, /No celebrity impressions/);
  assert.match(prompt, /Do not invent .* facts/);
  assert.match(prompt, /sourceUrls MUST be exactly the urls provided/);
  assert.match(prompt, /two-speaker exchange/);
  assert.match(prompt, /anchor: The Anchor/);
  assert.match(prompt, /analyst: The Analyst/);
  assert.match(prompt, /do not put speaker names inside the text/);
});

test("buildUserPrompt preserves source publisher and URL context", () => {
  const clusters: StoryCluster[] = [
    {
      canonicalKey: "test-story",
      category: "product-tools",
      headline: "A model ships a useful feature",
      whyItMatters: "Builders get a simpler path to production.",
      caveat: "Benchmarks are still early.",
      sources: [
        { publisher: "Example News", url: "https://example.com/model-feature" },
      ],
    },
  ];

  const prompt = buildUserPrompt("2026-05-11", clusters);

  assert.match(prompt, /Today is 2026-05-11/);
  assert.match(prompt, /STORY 1: A model ships a useful feature/);
  assert.match(prompt, /Category: Product & Tool Watch \(product-tools\)/);
  assert.match(prompt, /Example News: https:\/\/example\.com\/model-feature/);
});

test("buildSystemPrompt enforces hook, labels, concise transitions, pacing, and explainers", () => {
  const persona = DAILY_PERSONAS[0];
  assert.ok(persona, "at least one daily persona must be configured");

  const prompt = buildSystemPrompt(persona);

  assert.match(prompt, /Begin with an engaging summary hook/);
  assert.match(prompt, /exactly one segment per provided story cluster/);
  assert.match(prompt, /If fewer than three credible clusters are provided/);
  assert.match(prompt, /first segment title MUST begin "Top Story:/);
  assert.match(prompt, /Product & Tool Watch: \{headline\}/);
  assert.match(prompt, /smooth, short transition/);
  assert.match(prompt, /under about 12 words/);
  assert.match(prompt, /most sentences under about 24 words/);
  assert.match(prompt, /define specialized terms in 8-14 plain words/);
  assert.match(prompt, /Sound alert and enthusiastic/);
  assert.match(prompt, /both speakers throughout the episode/);
});

test("SCRIPT_RESPONSE_SCHEMA requires structured speaker turns", () => {
  const schema = SCRIPT_RESPONSE_SCHEMA;
  assert.equal(schema.properties.intro.type, "array");
  assert.equal(schema.properties.outro.type, "array");
  assert.equal(schema.properties.segments.items.properties.turns.type, "array");
  assert.deepEqual(
    schema.properties.segments.items.properties.turns.items.required,
    ["speaker", "text"],
  );
  assert.deepEqual(
    schema.properties.segments.items.properties.turns.items.properties.speaker.enum,
    ["anchor", "analyst"],
  );
});

test("buildUserPrompt tells the model not to pad fewer-than-three clusters", () => {
  const clusters: StoryCluster[] = [
    {
      canonicalKey: "research-story",
      category: "research",
      headline: "A benchmark exposes model planning gaps",
      whyItMatters: "Researchers get a clearer evaluation target.",
      caveat: "The benchmark may not match production tasks.",
      sources: [{ publisher: "Example Lab", url: "https://example.com/benchmark" }],
    },
    {
      canonicalKey: "policy-story",
      category: "policy-regulation",
      headline: "A regulator clarifies model audit rules",
      whyItMatters: "Builders get a better compliance map.",
      caveat: "The rules may still change after consultation.",
      sources: [{ publisher: "Example Policy", url: "https://example.com/rules" }],
    },
  ];

  const prompt = buildUserPrompt("2026-05-11", clusters);

  assert.match(prompt, /following 2 story clusters/);
  assert.match(prompt, /Return exactly 2 segment objects; never invent or pad/);
});

test("validateScriptResponse preserves segment count and source URLs", () => {
  const clusters: StoryCluster[] = [
    {
      canonicalKey: "test-story",
      category: "product-tools",
      headline: "A model ships a useful feature",
      whyItMatters: "Builders get a simpler path to production.",
      caveat: "Benchmarks are still early.",
      sources: [
        { publisher: "Example News", url: "https://example.com/model-feature" },
        { publisher: "Example Blog", url: "https://example.com/model-feature-details" },
      ],
    },
  ];

  validateScriptResponse(
    {
      intro: [
        { speaker: "anchor", text: "Here is the setup." },
        { speaker: "analyst", text: "And here is why it matters." },
      ],
      segments: [
        {
          title: "Top Story: A model ships a useful feature",
          turns: [
            { speaker: "anchor", text: "A concise segment." },
            { speaker: "analyst", text: "The practical takeaway is simple." },
          ],
          sourceUrls: [
            " https://example.com/model-feature-details ",
            "https://example.com/model-feature",
          ],
        },
      ],
      outro: [
        { speaker: "anchor", text: "That is the pattern." },
        { speaker: "analyst", text: "And that is the useful lens." },
      ],
    },
    clusters,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: [{ speaker: "anchor", text: "Here is the setup." }],
          segments: [],
          outro: [{ speaker: "analyst", text: "That is the pattern." }],
        },
        clusters,
      ),
    /expected 1/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: [{ speaker: "anchor", text: "Here is the setup." }],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              turns: [{ speaker: "analyst", text: "A concise segment." }],
              sourceUrls: ["https://example.com/changed"],
            },
          ],
          outro: [{ speaker: "analyst", text: "That is the pattern." }],
        },
        clusters,
      ),
    /sourceUrls do not match.*missing=.*model-feature.*extra=.*changed/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: [{ speaker: "anchor", text: "Here is the setup." }],
          outro: [{ speaker: "analyst", text: "That is the pattern." }],
        } as unknown as Parameters<typeof validateScriptResponse>[0],
        clusters,
      ),
    /segments must be an array/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: [{ speaker: "anchor", text: "Here is the setup." }],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              turns: [{ speaker: "analyst", text: "A concise segment." }],
            },
          ],
          outro: [{ speaker: "analyst", text: "That is the pattern." }],
        } as unknown as Parameters<typeof validateScriptResponse>[0],
        clusters,
      ),
    /sourceUrls must be an array/,
  );
});

test("validateScriptResponse rejects malformed speaker turns", () => {
  const clusters: StoryCluster[] = [
    {
      canonicalKey: "test-story",
      category: "product-tools",
      headline: "A model ships a useful feature",
      whyItMatters: "Builders get a simpler path to production.",
      caveat: "Benchmarks are still early.",
      sources: [{ publisher: "Example News", url: "https://example.com/model-feature" }],
    },
  ];

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: [],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              turns: [{ speaker: "anchor", text: "A concise segment." }],
              sourceUrls: ["https://example.com/model-feature"],
            },
          ],
          outro: [{ speaker: "analyst", text: "That is the pattern." }],
        },
        clusters,
      ),
    /intro turns must not be empty/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: [{ speaker: "producer", text: "Here is the setup." }],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              turns: [{ speaker: "anchor", text: "A concise segment." }],
              sourceUrls: ["https://example.com/model-feature"],
            },
          ],
          outro: [{ speaker: "analyst", text: "That is the pattern." }],
        } as unknown as Parameters<typeof validateScriptResponse>[0],
        clusters,
      ),
    /speaker must be "anchor" or "analyst"/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: [{ speaker: "anchor", text: "Here is the setup." }],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              turns: [{ speaker: "analyst", text: " " }],
              sourceUrls: ["https://example.com/model-feature"],
            },
          ],
          outro: [{ speaker: "analyst", text: "That is the pattern." }],
        } as unknown as Parameters<typeof validateScriptResponse>[0],
        clusters,
      ),
    /text must be a non-empty string/,
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
