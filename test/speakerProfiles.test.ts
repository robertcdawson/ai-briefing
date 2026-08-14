import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChunkSpeechInstructions,
  NARRATOR_PROFILE,
  resolveTTSDirection,
  sanitizeSegmentDeliveryHint,
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

test("sanitizeSegmentDeliveryHint strips brackets, angle brackets, and newlines, and collapses whitespace", () => {
  assert.equal(sanitizeSegmentDeliveryHint("[flat] let the\nnumber speak"), "flat let the number speak");
  assert.equal(sanitizeSegmentDeliveryHint("  <tag> {brace}  "), "tag brace");
});

test("sanitizeSegmentDeliveryHint returns undefined for empty, blank, or bracket-only input", () => {
  assert.equal(sanitizeSegmentDeliveryHint(undefined), undefined);
  assert.equal(sanitizeSegmentDeliveryHint(""), undefined);
  assert.equal(sanitizeSegmentDeliveryHint("   "), undefined);
  assert.equal(sanitizeSegmentDeliveryHint("[[[]]]"), undefined);
});

test("sanitizeSegmentDeliveryHint caps length at 60 characters", () => {
  const result = sanitizeSegmentDeliveryHint("x".repeat(100));
  assert.ok(result);
  assert.ok(result!.length <= 60, `expected <= 60 chars, got ${result!.length}`);
});

test("buildChunkSpeechInstructions appends a sanitized segment hint between Section and the footer", () => {
  const direction = {
    global: "global",
    narrator: "narrator delivery",
    intro: "intro section",
    story: "story section",
    outro: "outro section",
  };
  const instructions = buildChunkSpeechInstructions("story", direction, "[flat] let the number speak");

  assert.match(instructions, /This segment: flat let the number speak/);
  const lines = instructions.split("\n");
  const sectionIndex = lines.findIndex((l) => l.startsWith("Section:"));
  const hintIndex = lines.findIndex((l) => l.startsWith("This segment:"));
  const footerIndex = lines.findIndex((l) => l.includes("solo podcast monologue"));
  assert.ok(sectionIndex > -1 && hintIndex > -1 && footerIndex > -1);
  assert.ok(sectionIndex < hintIndex && hintIndex < footerIndex);
});

test("buildChunkSpeechInstructions omits the segment-hint line when absent or blank, byte-identical to the no-arg call", () => {
  const direction = {
    global: "global",
    narrator: "narrator delivery",
    intro: "intro section",
    story: "story section",
    outro: "outro section",
  };
  const withoutArg = buildChunkSpeechInstructions("story", direction);
  const withUndefined = buildChunkSpeechInstructions("story", direction, undefined);
  const withBlank = buildChunkSpeechInstructions("story", direction, "   ");

  assert.equal(withoutArg.includes("This segment:"), false);
  assert.equal(withoutArg, withUndefined);
  assert.equal(withoutArg, withBlank);
});
