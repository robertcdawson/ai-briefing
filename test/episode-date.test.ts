import assert from "node:assert/strict";
import test from "node:test";
import { resolveEpisodeDate } from "../src/episode-date.js";

test("resolveEpisodeDate defaults to the podcast publishing timezone", () => {
  const originalTimeZone = process.env.EPISODE_TIME_ZONE;
  delete process.env.EPISODE_TIME_ZONE;
  try {
    assert.equal(
      resolveEpisodeDate(new Date("2026-05-07T03:00:20.548Z")),
      "2026-05-06",
    );
  } finally {
    if (originalTimeZone === undefined) {
      delete process.env.EPISODE_TIME_ZONE;
    } else {
      process.env.EPISODE_TIME_ZONE = originalTimeZone;
    }
  }
});

test("resolveEpisodeDate honors an explicit timezone", () => {
  assert.equal(
    resolveEpisodeDate(new Date("2026-05-07T03:00:20.548Z"), "UTC"),
    "2026-05-07",
  );
});
