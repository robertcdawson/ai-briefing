import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FEED_LIMIT,
  RETENTION_DAYS,
  pruneOldEpisodes,
  resolveRetentionCutoff,
  selectFeedRecords,
  shouldPruneEpisodeFile,
} from "../src/publish.js";

async function makeTempEpisodesDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "publish-retention-test-"));
  for (const [filename, content] of Object.entries(files)) {
    await writeFile(path.join(dir, filename), content, "utf8");
  }
  return dir;
}

test("resolveRetentionCutoff subtracts calendar days from the episode date", () => {
  assert.equal(resolveRetentionCutoff("2026-07-06", 90), "2026-04-07");
  assert.equal(resolveRetentionCutoff("2026-01-15", 30), "2025-12-16");
});

test("shouldPruneEpisodeFile keeps protected and in-window episode files", () => {
  const keepDates = new Set(["2026-02-01"]);
  const cutoffDate = "2026-04-07";

  assert.equal(shouldPruneEpisodeFile("2026-03-01.mp3", keepDates, cutoffDate), true);
  assert.equal(shouldPruneEpisodeFile("2026-02-01.mp3", keepDates, cutoffDate), false);
  assert.equal(shouldPruneEpisodeFile("2026-04-07.mp3", keepDates, cutoffDate), false);
  assert.equal(shouldPruneEpisodeFile("2026-05-01.json", keepDates, cutoffDate), false);
  assert.equal(shouldPruneEpisodeFile("podcast-cover.jpg", keepDates, cutoffDate), false);
});

test("pruneOldEpisodes deletes expired asset families without stranding feed-listed episodes", async () => {
  const dir = await makeTempEpisodesDir({
    "2026-03-01.mp3": "audio",
    "2026-03-01.json": "{}",
    "2026-03-01.chapters.json": "{}",
    "2026-03-01.transcript.txt": "transcript",
    "2026-02-01.mp3": "protected audio",
    "2026-02-01.json": "{}",
    "2026-04-07.mp3": "cutoff audio",
    "2026-05-01.json": "{}",
    "podcast-cover.jpg": "not an episode asset",
  });

  try {
    const pruned = await pruneOldEpisodes(new Set(["2026-02-01"]), {
      episodesDir: dir,
      referenceDate: "2026-07-06",
      retentionDays: 90,
    });
    assert.deepEqual(pruned.sort(), [
      "2026-03-01.chapters.json",
      "2026-03-01.json",
      "2026-03-01.mp3",
      "2026-03-01.transcript.txt",
    ]);

    const remaining = await readdir(dir);
    assert.deepEqual(remaining.sort(), [
      "2026-02-01.json",
      "2026-02-01.mp3",
      "2026-04-07.mp3",
      "2026-05-01.json",
      "podcast-cover.jpg",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shipped retention window is exactly 14 days", () => {
  // The requirement is calendar-day age, not episode count: no episode may sit
  // in feed.xml (or survive on disk) once it is older than 14 days. Feed
  // membership is age-based (selectFeedRecords), so RETENTION_DAYS is the one
  // knob that governs both — this pins it against silent drift.
  assert.equal(RETENTION_DAYS, 14);
});

test("selectFeedRecords excludes episodes older than the retention window", () => {
  const records = [
    { date: "2026-08-21" }, // reference date itself — kept
    { date: "2026-08-07" }, // exactly 14 days old — kept (boundary)
    { date: "2026-08-06" }, // 15 days old — dropped
    { date: "2026-07-31" }, // 21 days old — dropped
  ];

  const top = selectFeedRecords(records, "2026-08-21", RETENTION_DAYS, FEED_LIMIT);
  assert.deepEqual(
    top.map((r) => r.date),
    ["2026-08-21", "2026-08-07"],
  );
});

test("selectFeedRecords applies feedLimit as a defensive count cap within the window", () => {
  const records = [
    { date: "2026-08-21" },
    { date: "2026-08-20" },
    { date: "2026-08-19" },
  ];

  const top = selectFeedRecords(records, "2026-08-21", RETENTION_DAYS, 2);
  assert.deepEqual(
    top.map((r) => r.date),
    ["2026-08-21", "2026-08-20"],
  );
});

test("shipped constants prune episodes that have aged out of the feed", async () => {
  const dir = await makeTempEpisodesDir({
    // In the feed — always kept, regardless of age.
    "2026-08-06.mp3": "current audio",
    "2026-08-06.json": "{}",
    // Off the feed and outside the retention window — the case that keeps
    // docs/ under the GitHub Pages 1 GB limit.
    "2026-06-01.mp3": "stale audio",
    "2026-06-01.transcript.txt": "stale transcript",
  });

  try {
    const pruned = await pruneOldEpisodes(new Set(["2026-08-06"]), {
      episodesDir: dir,
      referenceDate: "2026-08-06",
    });
    assert.deepEqual(pruned.sort(), ["2026-06-01.mp3", "2026-06-01.transcript.txt"]);
    assert.deepEqual((await readdir(dir)).sort(), ["2026-08-06.json", "2026-08-06.mp3"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pruneOldEpisodes treats a missing episode directory as empty", async () => {
  const missingDir = path.join(os.tmpdir(), `publish-retention-missing-${Date.now()}`);
  const pruned = await pruneOldEpisodes(new Set(), {
    episodesDir: missingDir,
    referenceDate: "2026-07-06",
  });
  assert.deepEqual(pruned, []);
});
