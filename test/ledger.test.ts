import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  buildRecentPhraseProfile,
  extractNarrationText,
  loadRecentCoverage,
  loadRecentStyleSnippets,
  parseTranscriptStyleSnippets,
} from "../src/ledger.js";
import type { CurationRecord } from "../src/types.js";

/** Build a minimal sidecar JSON with optional curation records. */
function makeSidecar(date: string, curation?: CurationRecord[]): string {
  const record: Record<string, unknown> = {
    date,
    title: `Episode ${date}`,
    description: "Test",
    durationSeconds: 300,
    byteLength: 1024,
    pubDate: new Date().toISOString(),
  };
  if (curation !== undefined) {
    record["curation"] = curation;
  }
  return JSON.stringify(record, null, 2);
}

function makeCuration(key: string): CurationRecord {
  return {
    canonicalKey: key,
    headline: `Headline for ${key}`,
    whyItMatters: `Why ${key} matters`,
    caveat: `Caveat for ${key}`,
    importance: 75,
    category: "research",
  };
}

/** Create a temporary directory, populate it with sidecars, return the dir path. */
async function makeTempDir(
  files: Record<string, string>,
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-test-"));
  for (const [filename, content] of Object.entries(files)) {
    await writeFile(path.join(dir, filename), content, "utf8");
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Happy path: window filtering
// ---------------------------------------------------------------------------
test("returns only curation entries from sidecars within the 14-day window", async () => {
  // today = 2026-06-17
  // window: [2026-06-03, 2026-06-17)
  const today = "2026-06-17";

  const dir = await makeTempDir({
    // Day 0 — today: excluded (strictly before)
    "2026-06-17.json": makeSidecar("2026-06-17", [makeCuration("today-story")]),
    // Day 1 — in window
    "2026-06-16.json": makeSidecar("2026-06-16", [makeCuration("day-1-story")]),
    // Day 14 — exactly 14 days ago, still in window (cutoff = today - 14 = 2026-06-03)
    "2026-06-03.json": makeSidecar("2026-06-03", [makeCuration("day-14-story")]),
    // Day 15 — outside window (= today - 15 = 2026-06-02)
    "2026-06-02.json": makeSidecar("2026-06-02", [makeCuration("day-15-story")]),
    // Day 20 — well outside window
    "2026-05-28.json": makeSidecar("2026-05-28", [makeCuration("old-story")]),
  });

  try {
    const entries = await loadRecentCoverage(today, 14, dir);

    const keys = entries.map((e) => e.canonicalKey);
    assert.ok(keys.includes("day-1-story"), "day-1-story should be in window");
    assert.ok(keys.includes("day-14-story"), "day-14-story at boundary should be in window");
    assert.ok(!keys.includes("today-story"), "today itself should be excluded");
    assert.ok(!keys.includes("day-15-story"), "day-15-story is outside window");
    assert.ok(!keys.includes("old-story"), "old-story is far outside window");

    // Each entry must carry episodeDate
    for (const entry of entries) {
      assert.ok(typeof entry.episodeDate === "string", "episodeDate must be present");
      assert.match(entry.episodeDate, /^\d{4}-\d{2}-\d{2}$/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Edge: no sidecars / empty directory
// ---------------------------------------------------------------------------
test("returns [] when the episodes directory is empty", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-test-empty-"));
  try {
    const entries = await loadRecentCoverage("2026-06-17", 14, dir);
    assert.deepEqual(entries, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Edge: missing directory
// ---------------------------------------------------------------------------
test("returns [] when the episodes directory does not exist", async () => {
  const nonexistent = path.join(os.tmpdir(), `ledger-test-nonexistent-${Date.now()}`);
  const entries = await loadRecentCoverage("2026-06-17", 14, nonexistent);
  assert.deepEqual(entries, []);
});

// ---------------------------------------------------------------------------
// Error path (AE4): malformed JSON sidecar in range is skipped; rest load
// ---------------------------------------------------------------------------
test("skips a malformed JSON sidecar in-range without throwing, and loads the rest", async () => {
  const today = "2026-06-17";

  const dir = await makeTempDir({
    "2026-06-16.json": makeSidecar("2026-06-16", [makeCuration("good-story")]),
    // Deliberately corrupt JSON
    "2026-06-15.json": "{ this is not valid json !!!",
    "2026-06-14.json": makeSidecar("2026-06-14", [makeCuration("another-good-story")]),
  });

  try {
    // Must NOT throw
    const entries = await loadRecentCoverage(today, 14, dir);
    const keys = entries.map((e) => e.canonicalKey);

    assert.ok(keys.includes("good-story"), "good-story should be returned");
    assert.ok(keys.includes("another-good-story"), "another-good-story should be returned");
    // The corrupt sidecar contributes nothing
    assert.equal(keys.length, 2, "exactly 2 entries from the two valid sidecars");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Edge: records lacking a `curation` field contribute nothing and don't error
// ---------------------------------------------------------------------------
test("sidecars without a curation field are silently skipped", async () => {
  const today = "2026-06-17";

  const dir = await makeTempDir({
    // No curation field (legacy/historical episode)
    "2026-06-16.json": makeSidecar("2026-06-16"),
    // Has curation
    "2026-06-15.json": makeSidecar("2026-06-15", [makeCuration("has-curation")]),
  });

  try {
    const entries = await loadRecentCoverage(today, 14, dir);
    assert.equal(entries.length, 1, "only the sidecar with curation contributes");
    assert.equal(entries[0]!.canonicalKey, "has-curation");
    assert.equal(entries[0]!.episodeDate, "2026-06-15");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Edge: empty curation array contributes nothing and doesn't error
// ---------------------------------------------------------------------------
test("sidecars with an empty curation array contribute nothing", async () => {
  const today = "2026-06-17";

  const dir = await makeTempDir({
    "2026-06-16.json": makeSidecar("2026-06-16", []),
    "2026-06-15.json": makeSidecar("2026-06-15", [makeCuration("real-story")]),
  });

  try {
    const entries = await loadRecentCoverage(today, 14, dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.canonicalKey, "real-story");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Multiple curation records in one sidecar are all returned
// ---------------------------------------------------------------------------
test("multiple curation records within a single sidecar are all returned", async () => {
  const today = "2026-06-17";

  const dir = await makeTempDir({
    "2026-06-16.json": makeSidecar("2026-06-16", [
      makeCuration("story-a"),
      makeCuration("story-b"),
      makeCuration("story-c"),
    ]),
  });

  try {
    const entries = await loadRecentCoverage(today, 14, dir);
    assert.equal(entries.length, 3);
    const keys = entries.map((e) => e.canonicalKey);
    assert.ok(keys.includes("story-a"));
    assert.ok(keys.includes("story-b"));
    assert.ok(keys.includes("story-c"));
    // All share the same episodeDate
    for (const e of entries) {
      assert.equal(e.episodeDate, "2026-06-16");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Window boundary: custom windowDays parameter is honored
// ---------------------------------------------------------------------------
test("custom windowDays parameter limits the window correctly", async () => {
  const today = "2026-06-17";

  const dir = await makeTempDir({
    "2026-06-16.json": makeSidecar("2026-06-16", [makeCuration("day-1")]),
    "2026-06-14.json": makeSidecar("2026-06-14", [makeCuration("day-3")]),
    "2026-06-10.json": makeSidecar("2026-06-10", [makeCuration("day-7")]),
  });

  try {
    // 3-day window: only [2026-06-14, 2026-06-17)
    const entries3 = await loadRecentCoverage(today, 3, dir);
    const keys3 = entries3.map((e) => e.canonicalKey);
    assert.ok(keys3.includes("day-1"), "day-1 is within 3-day window");
    assert.ok(keys3.includes("day-3"), "day-3 is exactly at boundary of 3-day window");
    assert.ok(!keys3.includes("day-7"), "day-7 is outside 3-day window");

    // 7-day window: [2026-06-10, 2026-06-17)
    const entries7 = await loadRecentCoverage(today, 7, dir);
    const keys7 = entries7.map((e) => e.canonicalKey);
    assert.ok(keys7.includes("day-1"));
    assert.ok(keys7.includes("day-3"));
    assert.ok(keys7.includes("day-7"), "day-7 is at boundary of 7-day window");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Style snippets: transcript parsing (buildTranscript format from publish.ts)
// ---------------------------------------------------------------------------

/** Build a transcript exactly the way buildTranscript in publish.ts does. */
function makeTranscript(date: string, options?: { signOff?: string }): string {
  const signOff = options?.signOff ?? "The evidence is in. Back tomorrow with the next lead.";
  return [
    `AI Briefing — Episode ${date}`,
    `Date: ${date}`,
    "",
    "Intro",
    "",
    "An AI agent went rogue during safety testing this week. Nobody told it to.",
    "",
    "It is a strange day for the industry, and this is the setup paragraph.",
    "",
    "Top Story: Something Happened",
    "",
    "First segment chunk with detail.",
    "",
    "Second segment chunk with more detail.",
    "Source: https://example.com/story-1",
    "",
    "Outro",
    "",
    "One question hangs over all of this: who checks the results?",
    "",
    signOff,
    "",
  ].join("\n");
}

test("parseTranscriptStyleSnippets extracts intro opener, outro opener, and sign-off", () => {
  const parsed = parseTranscriptStyleSnippets("2026-08-05", makeTranscript("2026-08-05"));

  assert.ok(parsed, "transcript in the standard layout must parse");
  assert.equal(parsed.episodeDate, "2026-08-05");
  assert.equal(
    parsed.introOpener,
    "An AI agent went rogue during safety testing this week.",
  );
  assert.equal(
    parsed.outroOpener,
    "One question hangs over all of this: who checks the results?",
  );
  assert.equal(parsed.signOff, "The evidence is in. Back tomorrow with the next lead.");
});

test("parseTranscriptStyleSnippets truncates long snippets to about 30 words", () => {
  const longSentence = `${Array.from({ length: 45 }, (_, i) => `word${i + 1}`).join(" ")}.`;
  const transcript = [
    "Title",
    "Date: 2026-08-05",
    "",
    "Intro",
    "",
    longSentence,
    "",
    "Outro",
    "",
    "Short closing thought.",
    "",
    "Short sign-off.",
    "",
  ].join("\n");

  const parsed = parseTranscriptStyleSnippets("2026-08-05", transcript);
  assert.ok(parsed);
  assert.equal(parsed.introOpener.split(/\s+/).length, 30);
  assert.ok(parsed.introOpener.endsWith("…"));
});

test("parseTranscriptStyleSnippets returns undefined for layouts it cannot parse", () => {
  assert.equal(parseTranscriptStyleSnippets("2026-05-19", "The Anchor: welcome back."), undefined);
  assert.equal(parseTranscriptStyleSnippets("2026-05-19", ""), undefined);
  // Outro header but no Intro header
  assert.equal(
    parseTranscriptStyleSnippets("2026-05-19", ["Outro", "", "Closing."].join("\n")),
    undefined,
  );
});

test("loadRecentStyleSnippets returns the most recent transcripts before today, newest first", async () => {
  const dir = await makeTempDir({
    "2026-08-01.transcript.txt": makeTranscript("2026-08-01", { signOff: "Sign-off one." }),
    "2026-08-02.transcript.txt": makeTranscript("2026-08-02", { signOff: "Sign-off two." }),
    "2026-08-03.transcript.txt": makeTranscript("2026-08-03", { signOff: "Sign-off three." }),
    // today: must be excluded
    "2026-08-04.transcript.txt": makeTranscript("2026-08-04", { signOff: "Sign-off today." }),
    // unparseable legacy transcript: skipped silently
    "2026-07-30.transcript.txt": "The Anchor: legacy two-host format.",
    // non-transcript files: ignored
    "2026-08-02.json": "{}",
  });

  try {
    const snippets = await loadRecentStyleSnippets("2026-08-04", 2, dir);

    assert.equal(snippets.length, 2);
    assert.deepEqual(
      snippets.map((s) => s.episodeDate),
      ["2026-08-03", "2026-08-02"],
    );
    assert.equal(snippets[0]!.signOff, "Sign-off three.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadRecentStyleSnippets returns [] for a missing directory", async () => {
  const nonexistent = path.join(os.tmpdir(), `ledger-style-nonexistent-${Date.now()}`);
  assert.deepEqual(await loadRecentStyleSnippets("2026-08-04", 8, nonexistent), []);
});

// ---------------------------------------------------------------------------
// extractNarrationText: narration-only text for the phrase tripwire / style report
// ---------------------------------------------------------------------------

test("extractNarrationText keeps narration and drops title/date/headers/segment-titles/source lines", () => {
  const transcript = makeTranscript("2026-08-05");
  const narration = extractNarrationText(transcript);

  assert.ok(!narration.includes("AI Briefing — Episode"), "title line must be stripped");
  assert.ok(!narration.includes("Date: 2026-08-05"), "Date line must be stripped");
  assert.ok(!narration.includes("Top Story: Something Happened"), "segment title line must be stripped");
  assert.ok(!narration.includes("Source: https://example.com/story-1"), "Source line must be stripped");

  const words = narration.split(/\s+/);
  assert.ok(!words.includes("Intro"), "Intro header must not leak into narration");
  assert.ok(!words.includes("Outro"), "Outro header must not leak into narration");

  assert.ok(narration.includes("An AI agent went rogue during safety testing this week."));
  assert.ok(narration.includes("First segment chunk with detail."));
  assert.ok(narration.includes("One question hangs over all of this: who checks the results?"));
  assert.ok(narration.includes("The evidence is in. Back tomorrow with the next lead."));
});

test("extractNarrationText strips category-label segment titles beyond Top Story", () => {
  const transcript = [
    "AI Briefing — Test",
    "Date: 2026-08-06",
    "",
    "Intro",
    "",
    "Intro sentence here.",
    "",
    "Research Breakthrough: A new benchmark result",
    "",
    "Segment narration line.",
    "Source: https://example.com/a",
    "",
    "Outro",
    "",
    "Closing sentence.",
    "",
    "Sign-off line.",
    "",
  ].join("\n");

  const narration = extractNarrationText(transcript);
  assert.ok(!narration.includes("Research Breakthrough: A new benchmark result"));
  assert.ok(narration.includes("Segment narration line."));
  assert.ok(narration.includes("Sign-off line."));
});

test("extractNarrationText returns an empty string for a transcript with no narration lines", () => {
  assert.equal(extractNarrationText(""), "");
  assert.equal(extractNarrationText("Just a title line"), "");
});

// ---------------------------------------------------------------------------
// buildRecentPhraseProfile: statistical anti-repetition tripwire
// ---------------------------------------------------------------------------

/** A transcript in buildTranscript's layout with caller-controlled narration sentences. */
function makeTranscriptWithNarration(date: string, sentences: string[]): string {
  return [
    `AI Briefing — Episode ${date}`,
    `Date: ${date}`,
    "",
    "Intro",
    "",
    sentences[0] ?? "An unremarkable intro sentence for this episode.",
    "",
    "Top Story: Something Happened",
    "",
    sentences[1] ?? "An unremarkable segment sentence for this episode.",
    "Source: https://example.com/story-1",
    "",
    "Outro",
    "",
    sentences[2] ?? "An unremarkable closing sentence for this episode.",
    "",
    sentences[3] ?? `Sign-off for ${date}.`,
    "",
  ].join("\n");
}

test("buildRecentPhraseProfile flags grams appearing in >= 3 of the last N episodes, ranked by episode count", async () => {
  const today = "2026-08-09";
  const dates = [
    "2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04",
    "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08",
  ];
  // Planted 4-gram "worth sitting with it" in 5 of 8 episodes.
  const wornDates = new Set(["2026-08-01", "2026-08-03", "2026-08-04", "2026-08-06", "2026-08-08"]);
  // A distinct phrase in only 2 episodes -- below the prompt threshold (3).
  const belowThresholdDates = new Set(["2026-08-02", "2026-08-05"]);

  const files: Record<string, string> = {};
  for (const date of dates) {
    const sentences = [
      wornDates.has(date)
        ? "This number is worth sitting with it for a while."
        : "Nothing unusual happens in this particular opening line today.",
      belowThresholdDates.has(date)
        ? "A rare phrase shows up only occasionally here."
        : "A perfectly ordinary segment sentence goes here instead.",
      "A closing thought for this episode.",
      `Sign-off for ${date}.`,
    ];
    files[`${date}.transcript.txt`] = makeTranscriptWithNarration(date, sentences);
  }

  const dir = await makeTempDir(files);
  try {
    const profile = await buildRecentPhraseProfile(today, 8, dir);

    const worn = profile.find((p) => p.gram === "worth sitting with it");
    assert.ok(worn, "expected the 5-episode gram to be flagged");
    assert.equal(worn!.episodeCount, 5);

    const belowThreshold = profile.find((p) => p.gram === "a rare phrase shows");
    assert.equal(belowThreshold, undefined, "a gram in only 2 episodes must not surface");

    // Sorted by episodeCount descending: the 5-episode gram must be first
    // among any grams sharing its count tier is fine, but it must not be
    // beaten by a lower-count gram.
    assert.ok(profile[0]!.episodeCount >= worn!.episodeCount);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildRecentPhraseProfile excludes all-stopword grams even above the episode threshold", async () => {
  const today = "2026-08-05";
  const dates = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"];

  const files: Record<string, string> = {};
  for (const date of dates) {
    files[`${date}.transcript.txt`] = makeTranscriptWithNarration(date, [
      "Consider whether of the a is relevant here.",
    ]);
  }

  const dir = await makeTempDir(files);
  try {
    const profile = await buildRecentPhraseProfile(today, 8, dir);
    assert.ok(
      !profile.some((p) => p.gram === "of the a is"),
      "an all-stopword gram must never be flagged, regardless of episode count",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildRecentPhraseProfile returns [] for a missing directory", async () => {
  const nonexistent = path.join(os.tmpdir(), `ledger-phrase-nonexistent-${Date.now()}`);
  assert.deepEqual(await buildRecentPhraseProfile("2026-08-09", 8, nonexistent), []);
});

test("buildRecentPhraseProfile excludes today's own transcript", async () => {
  const today = "2026-08-05";
  const dir = await makeTempDir({
    [`${today}.transcript.txt`]: makeTranscriptWithNarration(today, [
      "Only today mentions this unique zephyr cascade phrase today.",
    ]),
    "2026-08-04.transcript.txt": makeTranscriptWithNarration("2026-08-04", [
      "Only today mentions this unique zephyr cascade phrase today.",
    ]),
    "2026-08-03.transcript.txt": makeTranscriptWithNarration("2026-08-03", [
      "Only today mentions this unique zephyr cascade phrase today.",
    ]),
  });
  try {
    const profile = await buildRecentPhraseProfile(today, 8, dir);
    const hit = profile.find((p) => p.gram === "mentions this unique zephyr");
    // Present via the two prior days, but today's own transcript must not
    // contribute to its own count.
    assert.ok(!hit || hit.episodeCount === 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildRecentPhraseProfile respects the count window", async () => {
  const today = "2026-08-09";
  const dates = ["2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08"];
  const files: Record<string, string> = {};
  for (const date of dates) {
    files[`${date}.transcript.txt`] = makeTranscriptWithNarration(date, [
      "This shared phrase about widening gaps appears everywhere lately.",
    ]);
  }

  const dir = await makeTempDir(files);
  try {
    const fullWindow = await buildRecentPhraseProfile(today, 8, dir);
    const narrowWindow = await buildRecentPhraseProfile(today, 2, dir);

    const fullHit = fullWindow.find((p) => p.gram === "shared phrase about widening");
    assert.ok(fullHit);
    assert.equal(fullHit!.episodeCount, 5);

    // Only 2 of the 5 transcripts are read with count=2, so the same gram
    // cannot show more than 2 episodes -- or clears the 3-episode threshold
    // at all, in which case it's absent entirely.
    const narrowHit = narrowWindow.find((p) => p.gram === "shared phrase about widening");
    assert.ok(!narrowHit || narrowHit.episodeCount <= 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
