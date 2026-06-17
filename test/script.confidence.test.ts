import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt, buildUserPrompt, selectDailyPersona } from "../src/script.js";
import type { StoryCluster } from "../src/types.js";

function cluster(sources: { url: string; publisher: string }[]): StoryCluster {
  return {
    canonicalKey: "test-story",
    category: "product-tools",
    headline: "A model launched",
    whyItMatters: "It matters for builders.",
    caveat: "Details are thin.",
    importance: 80,
    sources,
  };
}

test("buildUserPrompt reports singular corroboration for a single-source story", () => {
  const prompt = buildUserPrompt("2026-06-17", [cluster([{ url: "https://a.com", publisher: "A" }])]);
  assert.match(prompt, /Corroboration: 1 independent source\b/);
  assert.doesNotMatch(prompt, /1 independent sources/);
});

test("buildUserPrompt reports plural corroboration for a multi-source story", () => {
  const prompt = buildUserPrompt("2026-06-17", [
    cluster([
      { url: "https://a.com", publisher: "A" },
      { url: "https://b.com", publisher: "B" },
      { url: "https://c.com", publisher: "C" },
    ]),
  ]);
  assert.match(prompt, /Corroboration: 3 independent sources/);
});

test("buildUserPrompt treats a story with no sources as unverified, not '0 independent sources'", () => {
  const prompt = buildUserPrompt("2026-06-17", [cluster([])]);
  assert.match(prompt, /Corroboration: none listed \(treat as unverified\)/);
  assert.doesNotMatch(prompt, /0 independent sources/);
});

test("system prompt instructs confidence calibration tied to corroboration", () => {
  const prompt = buildSystemPrompt(selectDailyPersona("2026-06-17"));
  assert.match(prompt, /CONFIDENCE AND SOURCING/);
  assert.match(prompt, /single-source/i);
  assert.match(prompt, /one outlet reports/i);
  // calibration cuts both ways — must not push toward blanket hedging
  assert.match(prompt, /over-hedge/i);
});
