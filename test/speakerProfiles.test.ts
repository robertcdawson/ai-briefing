import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChunkSpeechInstructions,
  NARRATOR_PROFILE,
  resolveTTSDirection,
} from "../src/speakerProfiles.js";

test("NARRATOR_PROFILE defines a single host with a natural default voice", () => {
  assert.equal(NARRATOR_PROFILE.defaultVoice, "marin");
  assert.match(NARRATOR_PROFILE.persona, /witty/i);
  assert.match(NARRATOR_PROFILE.delivery, /conversational/i);
});

test("resolveTTSDirection reads global, narrator, and section style env vars", () => {
  const direction = resolveTTSDirection({
    TTS_GLOBAL_STYLE: "global style",
    TTS_NARRATOR_STYLE: "narrator style",
    TTS_INTRO_STYLE: "intro style",
    TTS_STORY_STYLE: "story style",
    TTS_OUTRO_STYLE: "outro style",
  });

  assert.deepEqual(direction, {
    global: "global style",
    narrator: "narrator style",
    intro: "intro style",
    story: "story style",
    outro: "outro style",
  });
});

test("buildChunkSpeechInstructions composes global, host persona, delivery, section, and footer", () => {
  const instructions = buildChunkSpeechInstructions("intro", {
    global: "global",
    narrator: "narrator delivery",
    intro: "intro section",
    story: "story section",
    outro: "outro section",
  });

  assert.match(instructions, /^global\n/);
  assert.match(instructions, /Host: The Host is a sharp, witty/);
  assert.match(instructions, /Delivery: narrator delivery/);
  assert.match(instructions, /Section: intro section/);
  assert.match(instructions, /solo podcast monologue/);
});
