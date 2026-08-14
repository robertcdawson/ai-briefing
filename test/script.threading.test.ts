import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt, buildUserPrompt } from "../src/script.js";
import type { StoryCluster } from "../src/types.js";

const BASE_CLUSTER: StoryCluster = {
  canonicalKey: "model-release",
  category: "product-tools",
  headline: "A major lab ships a long-awaited model update",
  whyItMatters: "Builders get significantly better reasoning at the same price point.",
  caveat: "External benchmark results are not yet independently replicated.",
  importance: 80,
  sources: [{ publisher: "Example News", url: "https://example.com/model-update" }],
};

test("buildUserPrompt: cluster WITH followUp includes prior framing and follow-up marker", () => {
  const cluster: StoryCluster = {
    ...BASE_CLUSTER,
    followUp: {
      priorDate: "2026-06-10",
      priorFraming: "A major lab hinted at an imminent model upgrade affecting pricing.",
    },
  };

  const prompt = buildUserPrompt("2026-06-17", [cluster]);

  // Must contain the prior date
  assert.match(prompt, /Previously \(2026-06-10\)/);
  // Must contain the prior framing text
  assert.match(prompt, /A major lab hinted at an imminent model upgrade affecting pricing\./);
  // Must include the follow-up marker phrase
  assert.match(prompt, /FOLLOW-UP\/update, not a new story/);
  // No priorStance was set on this cluster, so no prior-take line renders.
  assert.equal(prompt.includes("Your prior take"), false);
});

test("buildUserPrompt: cluster WITH followUp AND priorStance includes the prior take", () => {
  const cluster: StoryCluster = {
    ...BASE_CLUSTER,
    followUp: {
      priorDate: "2026-06-10",
      priorFraming: "A major lab hinted at an imminent model upgrade affecting pricing.",
      priorStance: "I said this would slip past the announced date.",
    },
  };

  const prompt = buildUserPrompt("2026-06-17", [cluster]);

  assert.match(prompt, /Previously \(2026-06-10\)/);
  assert.ok(
    prompt.includes('Your prior take: "I said this would slip past the announced date."'),
  );
});

test("buildUserPrompt: cluster WITHOUT followUp renders no Previously line or follow-up marker", () => {
  const cluster: StoryCluster = { ...BASE_CLUSTER };

  const prompt = buildUserPrompt("2026-06-17", [cluster]);

  // Must NOT contain any Previously line
  assert.equal(prompt.includes("Previously"), false);
  // Must NOT contain a follow-up marker
  assert.equal(prompt.includes("FOLLOW-UP"), false);
  // Must still contain the standard fields
  assert.match(prompt, /STORY 1: A major lab ships a long-awaited model update/);
  assert.match(prompt, /Editor's note \(context only — never echo its wording\): Builders get significantly better reasoning/);
});

test("buildUserPrompt: mixed clusters — only the follow-up cluster gets the Previously line", () => {
  const newCluster: StoryCluster = {
    canonicalKey: "policy-story",
    category: "policy-regulation",
    headline: "A regulator finalizes new AI audit requirements",
    whyItMatters: "Builders now have a concrete compliance checklist.",
    caveat: "Rules take effect in six months, details still pending.",
    importance: 60,
    sources: [{ publisher: "Policy Watch", url: "https://example.com/audit-rules" }],
  };

  const followUpCluster: StoryCluster = {
    ...BASE_CLUSTER,
    followUp: {
      priorDate: "2026-06-10",
      priorFraming: "A major lab hinted at an imminent model upgrade affecting pricing.",
    },
  };

  const prompt = buildUserPrompt("2026-06-17", [newCluster, followUpCluster]);

  // The new story (STORY 1) must not have a Previously line
  const story1Block = prompt.split("STORY 2:")[0] ?? "";
  assert.equal(story1Block.includes("Previously"), false);

  // The follow-up story (STORY 2) must have the Previously line
  const story2Block = prompt.split("STORY 2:")[1] ?? "";
  assert.match(story2Block, /Previously \(2026-06-10\)/);
  assert.match(story2Block, /FOLLOW-UP\/update, not a new story/);
});

test("buildSystemPrompt: contains continuity-narration instruction for follow-up stories", () => {
  const prompt = buildSystemPrompt();

  // Must contain the follow-up handling instruction
  assert.match(prompt, /FOLLOW-UP STORIES/);
  // Must instruct continuation framing, not re-introduction
  assert.match(prompt, /open that segment as a continuation, not a fresh introduction/);
  // Must reference the Previously marker as the trigger
  assert.match(prompt, /"Previously" line/);
  // Must give a concrete example of update phrasing
  assert.match(prompt, /the rumor we flagged/);
  // Must instruct revisiting a recorded prior take
  assert.match(prompt, /prior take/);
  assert.match(prompt, /held up, was wrong, or is still open/);
});
