import assert from "node:assert/strict";
import test from "node:test";
import { selectStoryClusters } from "../src/curate.js";
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
