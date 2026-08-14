import assert from "node:assert/strict";
import test from "node:test";
import {
  INTRO_MOVES,
  OUTRO_MOVES,
  SEGMENT_SHAPES,
  assertNoWornPhrases,
  buildUserPrompt,
  selectIntroMove,
  selectOutroMove,
  selectSegmentShape,
  validateScriptResponse,
} from "../src/script.js";
import type { ScriptResponse } from "../src/script.js";
import type { RecentPhraseProfile, RecentStyleSnippets } from "../src/ledger.js";
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

test("selectSegmentShape is deterministic for the same date and index", () => {
  assert.deepEqual(selectSegmentShape("2026-08-06", 0), selectSegmentShape("2026-08-06", 0));
  assert.deepEqual(selectSegmentShape("2026-08-06", 2), selectSegmentShape("2026-08-06", 2));
});

test("selectSegmentShape always returns a member of SEGMENT_SHAPES", () => {
  for (let index = 0; index < 10; index += 1) {
    const shape = selectSegmentShape("2026-08-06", index);
    assert.ok(SEGMENT_SHAPES.includes(shape), `shape at index ${index} must be a configured shape`);
  }
});

test("selectSegmentShape varies between adjacent segment indices", () => {
  const shapesForOneDay = Array.from({ length: SEGMENT_SHAPES.length }, (_, i) =>
    selectSegmentShape("2026-08-06", i).name,
  );
  const uniqueShapes = new Set(shapesForOneDay);
  // Cycling through every index in one day, across SEGMENT_SHAPES.length
  // slots, must hit every distinct shape at least once (no index collapses
  // to a single repeated shape).
  assert.equal(uniqueShapes.size, SEGMENT_SHAPES.length);
  // Adjacent stories on the same day must not share a shape.
  for (let i = 0; i < shapesForOneDay.length - 1; i += 1) {
    assert.notEqual(shapesForOneDay[i], shapesForOneDay[i + 1]);
  }
});

test("selectSegmentShape rotates across dates for a fixed index", () => {
  const dates = [
    "2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04",
    "2026-08-05", "2026-08-06", "2026-08-07",
  ];
  const shapes = new Set(dates.map((date) => selectSegmentShape(date, 0).name));
  assert.ok(shapes.size > 1, "segment shapes at a fixed index should rotate across days");
});

test("buildUserPrompt renders the assigned shape for each story", () => {
  const prompt = buildUserPrompt("2026-08-06", CLUSTERS);
  const expectedShape = selectSegmentShape("2026-08-06", 0);

  assert.match(prompt, /Shape this segment as: /);
  assert.ok(prompt.includes(`Shape this segment as: ${expectedShape.name} — ${expectedShape.instruction}`));
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

// ---------------------------------------------------------------------------
// Phrase tripwire: worn-out phrasing subsection + hard-fail validator
// ---------------------------------------------------------------------------

const PHRASE_PROFILE: RecentPhraseProfile = [
  { gram: "worth sitting with", episodeCount: 5 },
  { gram: "the gap between promise", episodeCount: 4 },
  { gram: "a lot of", episodeCount: 3 },
];

test("buildUserPrompt lists worn-out phrasing under RECENTLY USED", () => {
  const prompt = buildUserPrompt("2026-08-06", CLUSTERS, undefined, PHRASE_PROFILE);

  assert.match(prompt, /RECENTLY USED/);
  assert.match(prompt, /Worn-out phrasing/);
  assert.ok(prompt.includes('- "worth sitting with" (5 episodes)'));
  assert.ok(prompt.includes('- "the gap between promise" (4 episodes)'));
});

test("buildUserPrompt renders the RECENTLY USED block from phraseProfile alone", () => {
  const prompt = buildUserPrompt("2026-08-06", CLUSTERS, undefined, PHRASE_PROFILE);
  assert.match(prompt, /RECENTLY USED/);
  assert.doesNotMatch(prompt, /Intro openers:/);
});

test("buildUserPrompt omits RECENTLY USED when both snippets and phraseProfile are empty", () => {
  assert.doesNotMatch(buildUserPrompt("2026-08-06", CLUSTERS, [], []), /RECENTLY USED/);
});

function responseWithNarration(text: string): ScriptResponse {
  return {
    intro: [text],
    segments: [
      {
        title: "Top Story: A model ships a useful feature",
        chunks: ["An ordinary segment sentence."],
        sourceUrls: ["https://example.com/model-feature"],
      },
    ],
    outro: ["An ordinary closing sentence.", "Back tomorrow."],
  };
}

test("assertNoWornPhrases rejects a gram appearing in >= 4 recent episodes", () => {
  assert.throws(
    () => assertNoWornPhrases(responseWithNarration("This number is worth sitting with today."), PHRASE_PROFILE),
    /worn-out phrasing/,
  );
  // Punctuation and case variants still normalize to the same gram.
  assert.throws(
    () =>
      assertNoWornPhrases(responseWithNarration("Worth Sitting With, honestly."), PHRASE_PROFILE),
    /worn-out phrasing/,
  );
});

test("assertNoWornPhrases allows a gram below the reject threshold", () => {
  // "a lot of" is at episodeCount 3, below PHRASE_REJECT_MIN_EPISODES (4).
  assertNoWornPhrases(responseWithNarration("There is a lot of nuance here."), PHRASE_PROFILE);
});

test("assertNoWornPhrases is a no-op for an empty profile", () => {
  assertNoWornPhrases(responseWithNarration("Worth sitting with this all day."), []);
});
