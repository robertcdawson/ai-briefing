import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt } from "../src/curate.js";
import { STORY_CATEGORY_DEFINITIONS } from "../src/types.js";

test("curation prompt scans every editorial lane before ranking by audience impact", () => {
  const prompt = buildSystemPrompt();

  for (const category of STORY_CATEGORY_DEFINITIONS) {
    assert.match(prompt, new RegExp(`${escapeRegExp(category.label)} .*${category.id}`));
  }

  assert.match(prompt, /SCAN every editorial lane before selecting stories/);
  assert.match(prompt, /audience impact for researchers, builders, and technical leaders/);
  assert.match(prompt, /novelty is only a tiebreaker/);
  assert.match(prompt, /preferring a diverse mix of categories/);
  assert.match(prompt, /never pad with weak material/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
