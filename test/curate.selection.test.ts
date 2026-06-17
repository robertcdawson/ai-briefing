import assert from "node:assert/strict";
import test from "node:test";
import { selectStoryClusters, normaliseCluster } from "../src/curate.js";
import type { StoryCluster } from "../src/types.js";

function cluster(key: string, importance: number | undefined): StoryCluster & { importance?: number } {
  return {
    canonicalKey: key,
    category: "product-tools",
    headline: `Headline for ${key}`,
    whyItMatters: "It matters.",
    caveat: "It is early.",
    importance,
    sources: [{ publisher: "Example", url: `https://example.com/${key}` }],
  };
}

test("selectStoryClusters returns an empty list when there are no clusters", () => {
  assert.deepEqual(selectStoryClusters([]), []);
});

test("selectStoryClusters keeps every story above the importance threshold, ranked high-to-low", () => {
  const selected = selectStoryClusters([
    cluster("low", 30),
    cluster("high", 90),
    cluster("mid", 60),
  ]);

  assert.deepEqual(
    selected.map((c) => c.canonicalKey),
    ["high", "mid"],
  );
});

test("selectStoryClusters falls back to the single strongest story when none clear the bar", () => {
  const selected = selectStoryClusters([
    cluster("weak", 10),
    cluster("weaker", 5),
    cluster("strongest-weak", 40),
  ]);

  assert.deepEqual(
    selected.map((c) => c.canonicalKey),
    ["strongest-weak"],
  );
});

test("selectStoryClusters caps the count at six even when more clear the bar", () => {
  const selected = selectStoryClusters(
    Array.from({ length: 9 }, (_, i) => cluster(`story-${i}`, 50 + i)),
  );

  assert.equal(selected.length, 6);
  // Highest scores survive the cap (50 + 8 down to 50 + 3).
  assert.deepEqual(
    selected.map((c) => c.canonicalKey),
    ["story-8", "story-7", "story-6", "story-5", "story-4", "story-3"],
  );
});

test("selectStoryClusters clamps out-of-range and missing importance into [0,100]", () => {
  const selected = selectStoryClusters([
    cluster("over", 999),
    cluster("under", -50),
    cluster("missing", undefined),
    cluster("normal", 80),
  ]);

  // 999 clamps to 100 (top); -50 and undefined clamp to 0 (below threshold).
  assert.deepEqual(
    selected.map((c) => c.canonicalKey),
    ["over", "normal"],
  );
});

// --- followUp passthrough tests ---

test("normaliseCluster carries followUp through when present", () => {
  const raw: StoryCluster & { importance?: number; followUp?: { priorDate: string; priorFraming: string } } = {
    canonicalKey: "openai-o3-confirmed",
    category: "research",
    headline: "OpenAI confirms O3 performance claims",
    whyItMatters: "Third-party verification of benchmark results.",
    caveat: "Limited external access so far.",
    importance: 75,
    sources: [{ publisher: "Reuters", url: "https://reuters.com/openai-o3" }],
    followUp: {
      priorDate: "2026-06-15",
      priorFraming: "We flagged unverified O3 benchmark claims on Monday.",
    },
  };
  const result = normaliseCluster(raw);
  assert.ok(result.followUp, "followUp should be present");
  assert.equal(result.followUp.priorDate, "2026-06-15");
  assert.equal(result.followUp.priorFraming, "We flagged unverified O3 benchmark claims on Monday.");
});

test("normaliseCluster does not add followUp when absent", () => {
  const raw: StoryCluster & { importance?: number } = {
    canonicalKey: "new-story",
    category: "business",
    headline: "Brand new story with no history",
    whyItMatters: "First time covered.",
    caveat: "Early reports only.",
    importance: 60,
    sources: [{ publisher: "Wired", url: "https://wired.com/new-story" }],
  };
  const result = normaliseCluster(raw);
  assert.equal(result.followUp, undefined);
});

test("selectStoryClusters preserves followUp field on selected clusters", () => {
  const followUpCluster: StoryCluster & { importance?: number } = {
    canonicalKey: "openai-o3-confirmed",
    category: "research",
    headline: "OpenAI confirms O3 performance claims",
    whyItMatters: "Third-party verification.",
    caveat: "Limited access.",
    importance: 75,
    sources: [{ publisher: "Reuters", url: "https://reuters.com/openai-o3" }],
    followUp: {
      priorDate: "2026-06-15",
      priorFraming: "We flagged unverified O3 claims on Monday.",
    },
  };
  const selected = selectStoryClusters([followUpCluster]);
  assert.equal(selected.length, 1);
  const first = selected[0];
  assert.ok(first, "first cluster should exist");
  assert.ok(first.followUp, "followUp should survive selectStoryClusters");
  assert.equal(first.followUp.priorDate, "2026-06-15");
  assert.equal(first.followUp.priorFraming, "We flagged unverified O3 claims on Monday.");
});

test("follow-up cluster counts toward MAX_STORIES budget like any other story", () => {
  // Build 6 follow-up clusters all above threshold — they should all be selected
  // (capped at 6 = MAX_STORIES), confirming they're treated normally.
  const followUps = Array.from({ length: 6 }, (_, i) => ({
    canonicalKey: `followup-story-${i}`,
    category: "business" as const,
    headline: `Follow-up story ${i}`,
    whyItMatters: "Continued coverage.",
    caveat: "Still developing.",
    importance: 50 + i,
    sources: [{ publisher: "Example", url: `https://example.com/${i}` }],
    followUp: {
      priorDate: "2026-06-15",
      priorFraming: `Previously covered story ${i}.`,
    },
  }));
  const selected = selectStoryClusters(followUps);
  assert.equal(selected.length, 6);
  // All follow-up fields should survive
  for (const s of selected) {
    assert.ok(s.followUp, `followUp should be present on ${s.canonicalKey}`);
  }
});

test("simulated LLM parse: clusters with followUp are normalised and selected correctly", () => {
  // Simulate the raw parsed response from the LLM (the shape that arrives after JSON.parse).
  const rawParsed: { clusters: (StoryCluster & { importance: number; followUp?: { priorDate: string; priorFraming: string } })[] } = {
    clusters: [
      {
        canonicalKey: "gpt-5-launch",
        category: "product-tools",
        headline: "GPT-5 officially launches with new pricing",
        whyItMatters: "Major capability and pricing shift.",
        caveat: "Enterprise tiers not yet available.",
        importance: 90,
        sources: [{ publisher: "OpenAI Blog", url: "https://openai.com/blog/gpt-5" }],
        followUp: {
          priorDate: "2026-06-14",
          priorFraming: "We covered leaked GPT-5 benchmarks two days ago.",
        },
      },
      {
        canonicalKey: "new-open-source-model",
        category: "open-source",
        headline: "New open-source model beats GPT-4 on code tasks",
        whyItMatters: "Free alternative for developers.",
        caveat: "Only tested on HumanEval.",
        importance: 65,
        sources: [{ publisher: "HuggingFace", url: "https://huggingface.co/new-model" }],
      },
    ],
  };

  // Apply the same normalise + select pipeline as curate() does.
  const normalised = rawParsed.clusters.map(normaliseCluster);
  const selected = selectStoryClusters(normalised);

  assert.equal(selected.length, 2);

  const gpt5 = selected.find((c) => c.canonicalKey === "gpt-5-launch");
  assert.ok(gpt5, "gpt-5-launch should be selected");
  assert.ok(gpt5.followUp, "followUp should be present on gpt-5-launch");
  assert.equal(gpt5.followUp?.priorDate, "2026-06-14");
  assert.equal(gpt5.followUp?.priorFraming, "We covered leaked GPT-5 benchmarks two days ago.");

  const newModel = selected.find((c) => c.canonicalKey === "new-open-source-model");
  assert.ok(newModel, "new-open-source-model should be selected");
  assert.equal(newModel.followUp, undefined, "no followUp on a fresh story");
});
