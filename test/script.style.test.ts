import assert from "node:assert/strict";
import test from "node:test";
import {
  INTRO_MOVES,
  OUTRO_MOVES,
  buildUserPrompt,
  selectIntroMove,
  selectOutroMove,
  validateScriptResponse,
} from "../src/script.js";
import type { ScriptResponse } from "../src/script.js";
import type { RecentStyleSnippets } from "../src/ledger.js";
import type { StoryCluster } from "../src/types.js";

const CLUSTERS: StoryCluster[] = [
  {
    canonicalKey: "test-story",
    category: "product-tools",
    headline: "A model ships a useful feature",
    whyItMatters: "Builders get a simpler path to production.",
    caveat: "Benchmarks are still early.",
    sources: [{ publisher: "Example News", url: "https://example.com/model-feature" }],
  },
];

function responseWithOutro(outro: string[]): ScriptResponse {
  return {
    intro: ["Here is the setup.", "Here is why it matters."],
    segments: [
      {
        title: "Top Story: A model ships a useful feature",
        chunks: ["A concise segment.", "The takeaway is simple."],
        sourceUrls: ["https://example.com/model-feature"],
      },
    ],
    outro,
  };
}

test("validateScriptResponse rejects the recurring outro molds", () => {
  const moldOutros: string[][] = [
    // "pull/step/zoom back" opener (first chunk only)
    ["Pull back and look at today's stories together, and something is clear.", "Good night."],
    ["Step back from today's individual stories for a moment.", "Good night."],
    ["Zoom back out and today looks different.", "Good night."],
    // "a pattern emerges" synthesis mold
    ["Look at today as a whole, and a pattern emerges: everyone is scaling.", "Good night."],
    ["Across the day's cases, a single thread runs through the coverage.", "Good night."],
    ["Listen closely and one frequency comes through clearly today.", "Good night."],
    // "Keep your X and your Y" sign-off mold
    ["The day ends where it started.", "Keep your sandboxes tight and your priors loose."],
    ["The day ends where it started.", "Keep your API keys off GitHub and your expectations calibrated."],
    // "That's the {bulletin} for {date}" mold
    ["The day ends where it started.", "That's the bulletin for August 5th."],
    ["The day ends where it started.", "That's your signal for today. Good night."],
    // "the gap between" outro framing
    ["The real story is the gap between capability and control.", "Good night."],
  ];

  for (const outro of moldOutros) {
    assert.throws(
      () => validateScriptResponse(responseWithOutro(outro), CLUSTERS),
      /banned/,
      `outro should be rejected: ${outro.join(" ")}`,
    );
  }
});

test("validateScriptResponse allows non-formulaic outros", () => {
  const freshOutros: string[][] = [
    ["The Volta deal closes in March; that's when this stops being theoretical.", "Back tomorrow."],
    // "pull back" not at the start of the first chunk is allowed
    ["One question lingers: who audits the auditors?", "If regulators pull back now, we'll know why."],
    // segment prose can still discuss gaps — only the outro is scoped
    ["Texas has a decision to make, and it has until Friday.", "See you when they make it."],
  ];

  for (const outro of freshOutros) {
    validateScriptResponse(responseWithOutro(outro), CLUSTERS);
  }
});

test("segment prose may still use 'the gap between' — only the outro is scoped", () => {
  const response: ScriptResponse = {
    intro: ["Here is the setup.", "Here is why it matters."],
    segments: [
      {
        title: "Top Story: A model ships a useful feature",
        chunks: ["The gap between the demo and the product is still wide.", "More soon."],
        sourceUrls: ["https://example.com/model-feature"],
      },
    ],
    outro: ["A quiet day ends loudly.", "Back tomorrow."],
  };
  validateScriptResponse(response, CLUSTERS);
});

test("validateScriptResponse rejects semicolon split contrast", () => {
  const response: ScriptResponse = {
    intro: [
      "That's not a hypothetical risk scenario; that's a documented incident.",
      "Here is why it matters.",
    ],
    segments: [
      {
        title: "Top Story: A model ships a useful feature",
        chunks: ["A concise segment.", "The takeaway is simple."],
        sourceUrls: ["https://example.com/model-feature"],
      },
    ],
    outro: ["A quiet day ends loudly.", "Back tomorrow."],
  };

  assert.throws(
    () => validateScriptResponse(response, CLUSTERS),
    /discouraged split contrast phrasing/,
  );
});

test("intro and outro moves are deterministic per date and vary across a week", () => {
  const dates = [
    "2026-08-01",
    "2026-08-02",
    "2026-08-03",
    "2026-08-04",
    "2026-08-05",
    "2026-08-06",
    "2026-08-07",
  ];

  for (const date of dates) {
    assert.equal(selectIntroMove(date), selectIntroMove(date));
    assert.equal(selectOutroMove(date), selectOutroMove(date));
    assert.ok(INTRO_MOVES.includes(selectIntroMove(date) as (typeof INTRO_MOVES)[number]));
    assert.ok(OUTRO_MOVES.includes(selectOutroMove(date) as (typeof OUTRO_MOVES)[number]));
  }

  assert.ok(new Set(dates.map(selectIntroMove)).size > 1, "intro moves should rotate");
  assert.ok(new Set(dates.map(selectOutroMove)).size > 1, "outro moves should rotate");
});

test("buildUserPrompt injects the daily opening and closing instructions", () => {
  const prompt = buildUserPrompt("2026-08-06", CLUSTERS);

  assert.match(prompt, /Today's opening instruction: /);
  assert.match(prompt, /Today's closing instruction: /);
  assert.ok(prompt.includes(selectIntroMove("2026-08-06")));
  assert.ok(prompt.includes(selectOutroMove("2026-08-06")));
});

test("buildUserPrompt lists recent style snippets under RECENTLY USED", () => {
  const recentStyle: RecentStyleSnippets[] = [
    {
      episodeDate: "2026-08-05",
      introOpener: "An AI agent being tested by the UK government went rogue.",
      outroOpener: "Pull back and look at today's six stories together.",
      signOff: "The evidence is in.",
    },
    {
      episodeDate: "2026-08-04",
      introOpener: "Texas froze new data center connections overnight.",
      outroOpener: "Pull back and look at today as a whole.",
      signOff: "Keep your access controls tighter than your benchmark claims.",
    },
  ];

  const prompt = buildUserPrompt("2026-08-06", CLUSTERS, recentStyle);

  assert.match(prompt, /RECENTLY USED/);
  assert.match(prompt, /Intro openers:/);
  assert.match(prompt, /Closing openers:/);
  assert.match(prompt, /Sign-offs:/);
  assert.ok(prompt.includes('(2026-08-05) "An AI agent being tested by the UK government went rogue."'));
  assert.ok(prompt.includes('(2026-08-04) "Keep your access controls tighter than your benchmark claims."'));
});

test("buildUserPrompt omits the RECENTLY USED block when there are no snippets", () => {
  assert.doesNotMatch(buildUserPrompt("2026-08-06", CLUSTERS), /RECENTLY USED/);
  assert.doesNotMatch(buildUserPrompt("2026-08-06", CLUSTERS, []), /RECENTLY USED/);
});
