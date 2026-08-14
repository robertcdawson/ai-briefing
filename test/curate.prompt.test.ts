import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt, buildUserPrompt, buildPriorCoverageBlock } from "../src/curate.js";
import { STORY_CATEGORY_DEFINITIONS } from "../src/types.js";
import type { PriorCoverageEntry } from "../src/ledger.js";

test("curation prompt scans every editorial lane before ranking by audience impact", () => {
  const prompt = buildSystemPrompt();

  for (const category of STORY_CATEGORY_DEFINITIONS) {
    assert.match(prompt, new RegExp(`${escapeRegExp(category.label)} .*${category.id}`));
  }

  assert.match(prompt, /SCAN every editorial lane before selecting stories/);
  assert.match(prompt, /audience impact for researchers, builders, and technical leaders/);
  assert.match(prompt, /novelty is only a tiebreaker/);
  assert.match(prompt, /RETURN the strongest distinct, credible stories as separate clusters/);
  assert.match(prompt, /at most 8/);
  assert.match(prompt, /honest importance score/);
  assert.match(prompt, /diverse mix of categories/);
  assert.match(prompt, /Never pad with weak material/);
});

test("system prompt instructs: suppress unless materially developed", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /SUPPRESS already-covered stories/);
  assert.match(prompt, /materially developed/);
});

test("system prompt instructs: bias toward surfacing when uncertain", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /PREFER including it as a short follow-up rather than dropping/);
  assert.match(prompt, /bias toward surfacing/);
});

test("system prompt instructs: always surface a major escalation", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /ALWAYS surface a major escalation/);
});

test("system prompt instructs: emit followUp field with priorDate, priorFraming, and priorStance", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /followUp/);
  assert.match(prompt, /priorDate/);
  assert.match(prompt, /priorFraming/);
  assert.match(prompt, /priorStance/);
});

test("buildUserPrompt with no prior coverage omits the recently-covered block", () => {
  const articles = [
    {
      title: "AI does a thing",
      source: "TechCrunch",
      url: "https://example.com/1",
      publishedAt: "2026-06-17T00:00:00Z",
      excerpt: "Some excerpt here.",
    },
  ];
  const prompt = buildUserPrompt(articles, []);
  assert.doesNotMatch(prompt, /Recently covered/);
  assert.doesNotMatch(prompt, /recently-covered/);
  assert.match(prompt, /Articles from the last 24 hours/);
});

test("buildUserPrompt with prior coverage includes the recently-covered block with canonicalKeys", () => {
  const articles = [
    {
      title: "AI does a thing",
      source: "TechCrunch",
      url: "https://example.com/1",
      publishedAt: "2026-06-17T00:00:00Z",
      excerpt: "Some excerpt here.",
    },
  ];
  const prior: PriorCoverageEntry[] = [
    {
      canonicalKey: "openai-releases-tts-3",
      headline: "OpenAI releases TTS 3",
      whyItMatters: "Better voice quality.",
      caveat: "Only available in the US.",
      importance: 70,
      category: "product-tools",
      episodeDate: "2026-06-15",
    },
    {
      canonicalKey: "google-deepmind-gemini-2",
      headline: "Google DeepMind releases Gemini 2",
      whyItMatters: "Multimodal advances.",
      caveat: "Benchmarks self-reported.",
      importance: 80,
      category: "research",
      episodeDate: "2026-06-14",
    },
  ];
  const prompt = buildUserPrompt(articles, prior);
  assert.match(prompt, /Recently covered/);
  assert.match(prompt, /openai-releases-tts-3/);
  assert.match(prompt, /google-deepmind-gemini-2/);
  assert.match(prompt, /2026-06-15/);
  assert.match(prompt, /2026-06-14/);
  assert.match(prompt, /suppress unless materially developed/);
  // Article block still present
  assert.match(prompt, /Articles from the last 24 hours/);
});

test("buildPriorCoverageBlock returns empty string for empty array", () => {
  assert.equal(buildPriorCoverageBlock([]), "");
});

test("buildPriorCoverageBlock includes all prior entries as compact lines", () => {
  const prior: PriorCoverageEntry[] = [
    {
      canonicalKey: "story-alpha",
      headline: "Alpha story headline",
      whyItMatters: "Matters a lot.",
      caveat: "Very early.",
      importance: 65,
      category: "business",
      episodeDate: "2026-06-16",
    },
  ];
  const block = buildPriorCoverageBlock(prior);
  assert.match(block, /story-alpha/);
  assert.match(block, /Alpha story headline/);
  assert.match(block, /Very early\./);
  assert.match(block, /2026-06-16/);
});

test("buildPriorCoverageBlock appends the prior take when stance is present, omits it otherwise", () => {
  const prior: PriorCoverageEntry[] = [
    {
      canonicalKey: "story-with-take",
      headline: "A story the host already judged",
      whyItMatters: "Matters a lot.",
      caveat: "Still developing.",
      importance: 70,
      category: "business",
      episodeDate: "2026-06-16",
      stance: "I called this overhyped.",
    },
    {
      canonicalKey: "story-without-take",
      headline: "A purely factual story",
      whyItMatters: "Matters some.",
      caveat: "Nothing uncertain.",
      importance: 55,
      category: "research",
      episodeDate: "2026-06-15",
    },
  ];
  const block = buildPriorCoverageBlock(prior);
  assert.match(block, /story-with-take \| A story the host already judged \| caveat: Still developing\. \| take: I called this overhyped\./);
  const withoutTakeLine = block.split("\n").find((line) => line.includes("story-without-take"));
  assert.ok(withoutTakeLine);
  assert.equal(withoutTakeLine!.includes("| take:"), false);
});

test("buildPriorCoverageBlock keeps a long stance from blowing out the line length", () => {
  const longStance = "x".repeat(500);
  const prior: PriorCoverageEntry[] = [
    {
      canonicalKey: "story-long-stance",
      headline: "A story with an unusually long recorded take",
      whyItMatters: "Matters.",
      caveat: "Uncertain.",
      importance: 60,
      category: "business",
      episodeDate: "2026-06-16",
      stance: longStance,
    },
  ];
  const block = buildPriorCoverageBlock(prior);
  const line = block.split("\n").find((l) => l.includes("story-long-stance"));
  assert.ok(line);
  assert.ok(line!.length <= 300, `line was ${line!.length} chars, expected <= 300`);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
