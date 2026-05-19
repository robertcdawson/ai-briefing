import assert from "node:assert/strict";
import test from "node:test";
import { EPISODE_SPEAKERS, speakerNamesForPrompt } from "../src/speakers.js";
import { SPEAKER_PROFILES } from "../src/speakerProfiles.js";

test("SPEAKER_PROFILES defines anchor and analyst with distinct default voices", () => {
  assert.equal(SPEAKER_PROFILES.anchor.defaultVoice, "cedar");
  assert.equal(SPEAKER_PROFILES.analyst.defaultVoice, "marin");
  assert.notEqual(SPEAKER_PROFILES.anchor.defaultVoice, SPEAKER_PROFILES.analyst.defaultVoice);
});

test("EPISODE_SPEAKERS mirrors profile persona text for script generation", () => {
  assert.equal(EPISODE_SPEAKERS.length, 2);
  assert.match(speakerNamesForPrompt(), /anchor: The Anchor — The Anchor is concise/);
  assert.match(speakerNamesForPrompt(), /analyst: The Analyst — The Analyst is warmer/);
});
