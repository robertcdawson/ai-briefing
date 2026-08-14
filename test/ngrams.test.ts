import assert from "node:assert/strict";
import test from "node:test";
import {
  NGRAM_STOPWORDS,
  collectGramEpisodes,
  extractNgrams,
  isAllStopwords,
  normalizeForNgrams,
} from "../src/ngrams.js";

test("normalizeForNgrams lowercases, strips punctuation, and collapses whitespace", () => {
  assert.equal(normalizeForNgrams("Hello, World!"), "hello world");
  assert.equal(normalizeForNgrams("state-of-the-art"), "state of the art");
  assert.equal(normalizeForNgrams("don't stop"), "dont stop");
  assert.equal(normalizeForNgrams("  multiple   spaces  "), "multiple spaces");
});

test("extractNgrams produces sliding-window word grams", () => {
  const grams = extractNgrams("the quick brown fox jumps", 3);
  assert.deepEqual(grams, ["the quick brown", "quick brown fox", "brown fox jumps"]);
});

test("extractNgrams never produces a gram spanning a sentence boundary", () => {
  const grams = extractNgrams("That is the end. This is the next one.", 4);
  for (const gram of grams) {
    assert.ok(!gram.includes("end this"), `gram "${gram}" crosses a sentence boundary`);
  }
  assert.ok(grams.includes("that is the end"));
  assert.ok(grams.includes("this is the next"));
});

test("extractNgrams returns [] for n <= 0 or text shorter than n words", () => {
  assert.deepEqual(extractNgrams("hello world", 0), []);
  assert.deepEqual(extractNgrams("hi", 3), []);
});

test("isAllStopwords is true only when every word is a stopword", () => {
  assert.ok(isAllStopwords("of the a"));
  assert.ok(!isAllStopwords("of the model"));
  assert.ok(isAllStopwords(""));
});

test("NGRAM_STOPWORDS contains common function words", () => {
  for (const word of ["the", "a", "of", "and", "is", "that"]) {
    assert.ok(NGRAM_STOPWORDS.has(word), `expected "${word}" to be a stopword`);
  }
});

test("collectGramEpisodes counts episode coverage, not raw occurrences", () => {
  const episodes = [
    { episodeDate: "2026-08-01", text: "worth sitting with it. worth sitting with it again." },
    { episodeDate: "2026-08-02", text: "worth sitting with it." },
    { episodeDate: "2026-08-03", text: "a completely different sentence entirely." },
  ];
  const result = collectGramEpisodes(episodes, [4]);
  const dates = result.get("worth sitting with it");
  assert.ok(dates, "expected the repeated gram to be tracked");
  assert.equal(dates!.size, 2, "two mentions in one episode still count as one episode");
  assert.deepEqual([...dates!].sort(), ["2026-08-01", "2026-08-02"]);
});

test("collectGramEpisodes respects the ns parameter", () => {
  const episodes = [{ episodeDate: "2026-08-01", text: "the quick brown fox jumps" }];
  const threeOnly = collectGramEpisodes(episodes, [3]);
  const fourOnly = collectGramEpisodes(episodes, [4]);
  assert.ok(threeOnly.has("the quick brown"));
  assert.ok(!fourOnly.has("the quick brown"));
  assert.ok(fourOnly.has("the quick brown fox"));
});

test("collectGramEpisodes defaults to 3- and 4-grams", () => {
  const episodes = [{ episodeDate: "2026-08-01", text: "the quick brown fox jumps" }];
  const result = collectGramEpisodes(episodes);
  assert.ok(result.has("the quick brown"), "3-grams present by default");
  assert.ok(result.has("the quick brown fox"), "4-grams present by default");
  assert.ok(!result.has("the quick brown fox jumps"), "5-grams not produced by default");
});
