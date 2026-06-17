import assert from "node:assert/strict";
import test from "node:test";
import { computeThreadingTally } from "../src/curate.js";
import type { StoryCluster } from "../src/types.js";
import type { PriorCoverageEntry } from "../src/ledger.js";

function makeCluster(key: string, withFollowUp = false): StoryCluster {
  const base: StoryCluster = {
    canonicalKey: key,
    category: "product-tools",
    headline: `Headline for ${key}`,
    whyItMatters: "It matters.",
    caveat: "It is early.",
    sources: [{ publisher: "Example", url: `https://example.com/${key}` }],
  };
  if (withFollowUp) {
    base.followUp = { priorDate: "2026-06-15", priorFraming: `Previously covered ${key}.` };
  }
  return base;
}

function makePrior(key: string): PriorCoverageEntry {
  return {
    canonicalKey: key,
    headline: `Prior headline for ${key}`,
    whyItMatters: "It mattered.",
    caveat: "It was early.",
    category: "product-tools",
    episodeDate: "2026-06-15",
  };
}

test("computeThreadingTally counts new vs follow-up correctly", () => {
  const selected = [
    makeCluster("story-a", false),
    makeCluster("story-b", true),
    makeCluster("story-c", false),
    makeCluster("story-d", true),
  ];
  const tally = computeThreadingTally(selected, []);
  assert.equal(tally.newCount, 2);
  assert.equal(tally.followUpCount, 2);
  assert.equal(tally.priorKeysNotResurfacedCount, 0);
  assert.deepEqual(tally.priorKeysNotResurfaced, []);
});

test("computeThreadingTally counts a prior-coverage key absent from selection as not-resurfaced", () => {
  const selected = [makeCluster("story-a", false)];
  const prior = [makePrior("story-prior-1"), makePrior("story-prior-2")];
  const tally = computeThreadingTally(selected, prior);
  assert.equal(tally.priorKeysNotResurfacedCount, 2);
  assert.deepEqual(tally.priorKeysNotResurfaced.sort(), ["story-prior-1", "story-prior-2"]);
  assert.equal(tally.newCount, 1);
  assert.equal(tally.followUpCount, 0);
});

test("computeThreadingTally does NOT count a prior key present in selected as not-resurfaced", () => {
  // story-resurfaced appears in both prior coverage and selected clusters (as new)
  const selected = [makeCluster("story-resurfaced", false), makeCluster("story-new", false)];
  const prior = [makePrior("story-resurfaced"), makePrior("story-gone")];
  const tally = computeThreadingTally(selected, prior);
  assert.equal(tally.priorKeysNotResurfacedCount, 1);
  assert.deepEqual(tally.priorKeysNotResurfaced, ["story-gone"]);
});

test("computeThreadingTally does NOT count a prior key present as a follow-up as not-resurfaced", () => {
  // story-resurfaced appears in prior coverage AND is selected as a follow-up
  const selected = [makeCluster("story-resurfaced", true)];
  const prior = [makePrior("story-resurfaced"), makePrior("story-gone")];
  const tally = computeThreadingTally(selected, prior);
  assert.equal(tally.followUpCount, 1);
  assert.equal(tally.priorKeysNotResurfacedCount, 1);
  assert.deepEqual(tally.priorKeysNotResurfaced, ["story-gone"]);
});

test("computeThreadingTally returns priorKeysNotResurfacedCount 0 with empty prior coverage", () => {
  const selected = [makeCluster("story-a", false), makeCluster("story-b", true)];
  const tally = computeThreadingTally(selected, []);
  assert.equal(tally.priorKeysNotResurfacedCount, 0);
  assert.deepEqual(tally.priorKeysNotResurfaced, []);
  assert.equal(tally.newCount, 1);
  assert.equal(tally.followUpCount, 1);
});

test("computeThreadingTally deduplicates prior-coverage keys that appear more than once", () => {
  // Same canonicalKey appearing in two prior episodes — should only be counted once as not-resurfaced
  const prior = [makePrior("story-x"), { ...makePrior("story-x"), episodeDate: "2026-06-14" }];
  const tally = computeThreadingTally([], prior);
  assert.equal(tally.priorKeysNotResurfacedCount, 1);
  assert.deepEqual(tally.priorKeysNotResurfaced, ["story-x"]);
});
