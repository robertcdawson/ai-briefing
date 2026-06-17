import assert from "node:assert/strict";
import test from "node:test";
import { resolveEpisodeDate, isDateInWindow } from "../src/episode-date.js";

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

// F11: isDateInWindow unit tests

test("isDateInWindow: candidate == today returns false (today-exclusion)", () => {
  assert.equal(isDateInWindow("2026-06-17", "2026-06-17", 14), false);
});

test("isDateInWindow: candidate == today - windowDays returns true (cutoff inclusion)", () => {
  // today=2026-06-17, windowDays=14 → cutoff=2026-06-03; candidate==cutoff → true
  assert.equal(isDateInWindow("2026-06-03", "2026-06-17", 14), true);
});

test("isDateInWindow: year-boundary span (today=2026-01-07, candidate=2025-12-25, windowDays=14) returns true", () => {
  // cutoff = 2026-01-07 - 14 days = 2025-12-24; 2025-12-25 >= 2025-12-24 and < 2026-01-07 → true
  assert.equal(isDateInWindow("2025-12-25", "2026-01-07", 14), true);
});

test("isDateInWindow: windowDays=0 makes everything false (zero-width window)", () => {
  // cutoff = today itself; candidate must be < today AND >= today → impossible
  assert.equal(isDateInWindow("2026-06-16", "2026-06-17", 0), false);
  assert.equal(isDateInWindow("2026-06-17", "2026-06-17", 0), false);
  assert.equal(isDateInWindow("2026-06-10", "2026-06-17", 0), false);
});

test("isDateInWindow: normal in-window true case", () => {
  // candidate one week before today, within 14-day window
  assert.equal(isDateInWindow("2026-06-10", "2026-06-17", 14), true);
});
