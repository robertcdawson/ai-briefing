import test from "node:test";
import assert from "node:assert/strict";
import { scoreAndSelect, selectStoryClusters } from "../src/curate.js";
import type { StoryCluster } from "../src/types.js";

function cluster(key: string, importance: number): StoryCluster & { importance: number } {
  return {
    canonicalKey: key,
    category: "research",
    headline: `Headline ${key}`,
    whyItMatters: "matters",
    caveat: "caveat",
    importance,
    sources: [{ url: `https://example.com/${key}`, publisher: "Ex" }],
  };
}

test("scoreAndSelect reports every input cluster with correct selected flags and counts", () => {
  // 8 above threshold (only 6 can air) + 2 below threshold.
  const above = Array.from({ length: 8 }, (_, i) => cluster(`a${i}`, 90 - i));
  const below = [cluster("b0", 30), cluster("b1", 10)];
  const { selected, report } = scoreAndSelect([...above, ...below]);

  assert.equal(selected.length, 6);
  assert.equal(report.total, 10);
  assert.equal(report.selectedCount, 6);
  assert.equal(report.droppedCount, 4);
  assert.equal(report.clusters.length, 10, "report includes every input cluster");
  assert.equal(report.threshold, 45);
  assert.equal(report.maxStories, 6);
});

test("scoreAndSelect tags drop reasons: over_cap for above-bar overflow, below_threshold otherwise", () => {
  const above = Array.from({ length: 8 }, (_, i) => cluster(`a${i}`, 90 - i));
  const below = [cluster("b0", 30), cluster("b1", 10)];
  const { report } = scoreAndSelect([...above, ...below]);

  const overCap = report.clusters.filter((c) => c.dropReason === "over_cap");
  const belowThreshold = report.clusters.filter((c) => c.dropReason === "below_threshold");
  assert.equal(overCap.length, 2, "2 above-threshold clusters squeezed out by the cap");
  assert.equal(belowThreshold.length, 2, "2 sub-threshold clusters");

  // Selected clusters carry no dropReason.
  for (const c of report.clusters.filter((c) => c.selected)) {
    assert.equal(c.dropReason, undefined);
  }
});

test("scoreAndSelect MIN_STORIES fallback: keeps the single strongest when none clear the bar", () => {
  const { selected, report } = scoreAndSelect([cluster("x", 10), cluster("y", 30), cluster("z", 20)]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]!.canonicalKey, "y", "strongest story is kept");

  const kept = report.clusters.find((c) => c.selected)!;
  assert.equal(kept.canonicalKey, "y");
  assert.equal(kept.dropReason, undefined);
  // The rescued story is NOT mislabeled below_threshold; the others are.
  assert.equal(report.clusters.filter((c) => c.dropReason === "below_threshold").length, 2);
});

test("scoreAndSelect is behavior-neutral: .selected equals selectStoryClusters output", () => {
  const input = [cluster("a", 80), cluster("b", 50), cluster("c", 20), cluster("d", 95)];
  assert.deepEqual(scoreAndSelect(input).selected, selectStoryClusters(input));
});
