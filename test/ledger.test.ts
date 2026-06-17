import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadRecentCoverage } from "../src/ledger.js";
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
