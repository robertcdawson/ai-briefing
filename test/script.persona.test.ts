import assert from "node:assert/strict";
import test from "node:test";
import {
  DAILY_PERSONAS,
  buildSystemPrompt,
  buildUserPrompt,
  selectDailyPersona,
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
});

test("buildUserPrompt preserves source publisher and URL context", () => {
  const clusters: StoryCluster[] = [
    {
      canonicalKey: "test-story",
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
  assert.match(prompt, /Example News: https:\/\/example\.com\/model-feature/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
