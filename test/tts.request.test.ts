import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChunkSpeechRequest,
  buildConcatSpeechArgs,
  buildSpeechRequest,
  DEFAULT_GLOBAL_TTS_STYLE,
  resolveNarratorVoice,
  resolveTTSDirection,
  resolveTTSTimeoutMs,
} from "../src/tts.js";
import { buildChunkSpeechInstructions } from "../src/speakerProfiles.js";

test("buildSpeechRequest adds global delivery instructions for instructable TTS models", () => {
  const request = buildSpeechRequest("Short podcast intro.", "onyx", "gpt-4o-mini-tts");

  assert.equal(request.model, "gpt-4o-mini-tts");
  assert.equal(request.response_format, "mp3");
  assert.equal(request.instructions, DEFAULT_GLOBAL_TTS_STYLE);
  assert.match(request.instructions ?? "", /never announcer-y/i);
});

test("buildSpeechRequest omits delivery instructions for legacy TTS models", () => {
  const request = buildSpeechRequest("Short podcast intro.", "onyx", "tts-1-hd");

  assert.equal(request.model, "tts-1-hd");
  assert.equal(request.instructions, undefined);
});

test("resolveTTSTimeoutMs uses a realistic default and accepts valid overrides", () => {
  assert.equal(resolveTTSTimeoutMs(undefined), 180_000);
  assert.equal(resolveTTSTimeoutMs("240000"), 240_000);
  assert.equal(resolveTTSTimeoutMs("1000"), 180_000);
  assert.equal(resolveTTSTimeoutMs("not-a-number"), 180_000);
});

test("resolveNarratorVoice defaults to marin and accepts valid overrides", () => {
  assert.equal(resolveNarratorVoice({}), "marin");
  assert.equal(resolveNarratorVoice({ TTS_VOICE: "cedar" }), "cedar");
  assert.equal(resolveNarratorVoice({ TTS_VOICE: "not-a-voice" }), "marin");
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

test("buildChunkSpeechRequest uses the narrator voice and section-aware instructions", () => {
  const direction = resolveTTSDirection({
    TTS_GLOBAL_STYLE: "podcast global",
    TTS_NARRATOR_STYLE: "host delivery",
    TTS_STORY_STYLE: "measured story",
    TTS_OUTRO_STYLE: "warm outro",
  });

  const storyRequest = buildChunkSpeechRequest(
    "Here is the fact pattern.",
    "marin",
    "gpt-4o-mini-tts",
    "story",
    direction,
  );
  const outroRequest = buildChunkSpeechRequest(
    "So here is the throughline.",
    "cedar",
    "gpt-4o-mini-tts",
    "outro",
    direction,
  );

  assert.equal(storyRequest.voice, "marin");
  assert.equal(storyRequest.input, "Here is the fact pattern.");
  assert.match(storyRequest.instructions ?? "", /podcast global/);
  assert.match(storyRequest.instructions ?? "", /host delivery/);
  assert.match(storyRequest.instructions ?? "", /Section: measured story/);

  assert.equal(outroRequest.voice, "cedar");
  assert.match(outroRequest.instructions ?? "", /Section: warm outro/);
});

test("buildConcatSpeechArgs re-encodes chunk audio instead of stream-copying MP3s", () => {
  const args = buildConcatSpeechArgs(["01.mp3", "02.mp3"], "part.mp3");

  assert.deepEqual(args.slice(0, 7), [
    "-y",
    "-loglevel",
    "error",
    "-i",
    "01.mp3",
    "-i",
    "02.mp3",
  ]);
  assert.ok(args.includes("-filter_complex"));
  assert.ok(args.includes("[0:a:0][1:a:0]concat=n=2:v=0:a=1[a]"));
  assert.ok(args.includes("libmp3lame"));
  assert.equal(args.includes("-c"), false);
  assert.equal(args.includes("copy"), false);
});
