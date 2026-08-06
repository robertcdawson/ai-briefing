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

test("shipped retention window covers the calendar span of a full feed", () => {
  // The keepDates guard already protects everything in the feed, so RETENTION_DAYS
  // only does work beyond that span. Set it shorter than the feed and the feed
  // silently becomes the real retention policy; set it much longer (the old 90)
  // and disk grows unbounded relative to the feed. FEED_LIMIT weekdays spans
  // ceil(FEED_LIMIT / 5) weekends' worth of extra days.
  const weekdaySpanDays = FEED_LIMIT + 2 * Math.ceil(FEED_LIMIT / 5);
  assert.ok(
    RETENTION_DAYS >= weekdaySpanDays,
    `RETENTION_DAYS (${RETENTION_DAYS}) must cover ${weekdaySpanDays} days of weekday episodes`,
  );
  assert.ok(
    RETENTION_DAYS <= weekdaySpanDays + 7,
    `RETENTION_DAYS (${RETENTION_DAYS}) keeps far more on disk than the ${FEED_LIMIT}-episode feed`,
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
