import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_METADISCOURSE_MARKERS,
  computeEpisodeStyleMetrics,
  computeStyleReport,
} from "../src/styleMetrics.js";

test("computeEpisodeStyleMetrics counts words and sentences and computes mean/variance", () => {
  // Three sentences of 2, 4, 6 words: mean 4, variance ((2-4)^2+(4-4)^2+(6-4)^2)/3 = 8/3.
  const metrics = computeEpisodeStyleMetrics({
    episodeDate: "2026-08-01",
    narrationText: "One two. One two three four. One two three four five six.",
  });
  assert.equal(metrics.episodeDate, "2026-08-01");
  assert.equal(metrics.sentenceCount, 3);
  assert.equal(metrics.wordCount, 12);
  assert.equal(metrics.meanSentenceWords, 4);
  assert.ok(Math.abs(metrics.sentenceWordVariance - 8 / 3) < 1e-9);
});

test("computeEpisodeStyleMetrics returns zeros for empty text", () => {
  const metrics = computeEpisodeStyleMetrics({ episodeDate: "2026-08-01", narrationText: "" });
  assert.equal(metrics.sentenceCount, 0);
  assert.equal(metrics.wordCount, 0);
  assert.equal(metrics.meanSentenceWords, 0);
  assert.equal(metrics.sentenceWordVariance, 0);
});

test("computeEpisodeStyleMetrics detects each antithesis pattern at least once", () => {
  const samples = [
    "That is not compliance. That is stalling.",
    "That's not a hypothetical risk; that's what happened.",
    "It's less a hammer, more a scalpel.",
    "AI assistants are no longer a niche product. They're infrastructure.",
  ];
  for (const sample of samples) {
    const metrics = computeEpisodeStyleMetrics({ episodeDate: "2026-08-01", narrationText: sample });
    assert.ok(metrics.antithesisCount >= 1, `expected an antithesis hit in: "${sample}"`);
  }
});

test("computeEpisodeStyleMetrics counts triads", () => {
  const metrics = computeEpisodeStyleMetrics({
    episodeDate: "2026-08-01",
    narrationText: "It was faster, cheaper, and smarter than before.",
  });
  assert.ok(metrics.triadCount >= 1);
});

test("computeEpisodeStyleMetrics counts metadiscourse markers case-insensitively", () => {
  const metrics = computeEpisodeStyleMetrics({
    episodeDate: "2026-08-01",
    narrationText: "This number is Worth Sitting With for a moment.",
  });
  assert.ok(metrics.metadiscourseCount >= 1);
});

test("DEFAULT_METADISCOURSE_MARKERS includes the documented tics", () => {
  assert.ok(DEFAULT_METADISCOURSE_MARKERS.includes("worth sitting with"));
  assert.ok(DEFAULT_METADISCOURSE_MARKERS.includes("worth noting"));
});

test("computeStyleReport surfaces grams appearing in at least minEpisodes episodes", () => {
  const episodes = [
    { episodeDate: "2026-08-01", narrationText: "The gap between promise and delivery is real." },
    { episodeDate: "2026-08-02", narrationText: "The gap between promise and delivery keeps widening." },
    { episodeDate: "2026-08-03", narrationText: "The gap between promise and delivery is the story." },
    { episodeDate: "2026-08-04", narrationText: "Nothing repeated here at all." },
  ];
  const report = computeStyleReport(episodes, { minEpisodes: 3 });
  assert.equal(report.episodes.length, 4);
  const hit = report.repeatedGrams.find((g) => g.gram === "the gap between promise");
  assert.ok(hit, "expected a repeated 4-gram across 3 episodes");
  assert.equal(hit!.episodeCount, 3);
  assert.deepEqual(hit!.dates, ["2026-08-01", "2026-08-02", "2026-08-03"]);
});

test("computeStyleReport excludes all-stopword grams and below-threshold grams", () => {
  const episodes = [
    { episodeDate: "2026-08-01", narrationText: "and of the a" },
    { episodeDate: "2026-08-02", narrationText: "and of the a" },
    { episodeDate: "2026-08-03", narrationText: "one unique story here" },
  ];
  const report = computeStyleReport(episodes, { minEpisodes: 2 });
  assert.ok(!report.repeatedGrams.some((g) => g.gram === "and of the"));
});

test("computeStyleReport sorts repeated grams by episode count descending", () => {
  const episodes = [
    { episodeDate: "2026-08-01", narrationText: "Zenith modules crossed the threshold quietly today." },
    { episodeDate: "2026-08-02", narrationText: "Analysts say zenith modules crossed the threshold early." },
    { episodeDate: "2026-08-03", narrationText: "Nobody expected zenith modules crossed the threshold this fast." },
    { episodeDate: "2026-08-04", narrationText: "A wildly different sentence about something else entirely." },
  ];
  const report = computeStyleReport(episodes, { minEpisodes: 2 });
  assert.ok(report.repeatedGrams.length > 0);
  // Whatever sorts first must hold the maximum episodeCount in the report.
  const maxCount = Math.max(...report.repeatedGrams.map((g) => g.episodeCount));
  assert.equal(report.repeatedGrams[0]!.episodeCount, maxCount);
  const fourGram = report.repeatedGrams.find((g) => g.gram === "zenith modules crossed the");
  assert.ok(fourGram, "expected the shared 4-gram to be present");
  assert.equal(fourGram!.episodeCount, 3);
});
