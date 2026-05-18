import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConcatSpeechArgs,
  buildSpeechRequest,
  buildTurnSpeechRequest,
  DEFAULT_GLOBAL_TTS_STYLE,
  resolveSpeakerVoices,
  resolveTTSDirection,
  resolveTTSTimeoutMs,
} from "../src/tts.js";
import { buildTurnSpeechInstructions } from "../src/speakerProfiles.js";

test("buildSpeechRequest adds global delivery instructions for instructable TTS models", () => {
  const request = buildSpeechRequest("Short podcast intro.", "onyx", "gpt-4o-mini-tts");

  assert.equal(request.model, "gpt-4o-mini-tts");
  assert.equal(request.response_format, "mp3");
  assert.equal(request.instructions, DEFAULT_GLOBAL_TTS_STYLE);
  assert.match(request.instructions ?? "", /no fake enthusiasm/i);
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

test("resolveSpeakerVoices chooses per-speaker voices with profile defaults", () => {
  assert.deepEqual(resolveSpeakerVoices({}), { anchor: "cedar", analyst: "marin" });
  assert.deepEqual(
    resolveSpeakerVoices({
      TTS_VOICE: "echo",
      TTS_ANALYST_VOICE: "shimmer",
    }),
    { anchor: "echo", analyst: "shimmer" },
  );
  assert.deepEqual(
    resolveSpeakerVoices({
      TTS_VOICE: "invalid",
      TTS_ANCHOR_VOICE: "onyx",
      TTS_ANALYST_VOICE: "also-invalid",
    }),
    { anchor: "onyx", analyst: "marin" },
  );
});

test("resolveTTSDirection reads global, speaker, and section style env vars", () => {
  const direction = resolveTTSDirection({
    TTS_GLOBAL_STYLE: "global style",
    TTS_ANCHOR_STYLE: "anchor style",
    TTS_ANALYST_STYLE: "analyst style",
    TTS_INTRO_STYLE: "intro style",
    TTS_STORY_STYLE: "story style",
    TTS_OUTRO_STYLE: "outro style",
  });

  assert.deepEqual(direction, {
    global: "global style",
    anchor: "anchor style",
    analyst: "analyst style",
    intro: "intro style",
    story: "story style",
    outro: "outro style",
  });
});

test("buildTurnSpeechInstructions composes global, persona, delivery, section, and dialogue footer", () => {
  const instructions = buildTurnSpeechInstructions("anchor", "intro", {
    global: "global",
    anchor: "anchor delivery",
    analyst: "analyst delivery",
    intro: "intro section",
    story: "story section",
    outro: "outro section",
  });

  assert.match(instructions, /^global\n/);
  assert.match(instructions, /Speaker persona: The Anchor is concise/);
  assert.match(instructions, /Delivery: anchor delivery/);
  assert.match(instructions, /Section: intro section/);
  assert.match(instructions, /Do not say speaker labels/);
});

test("buildTurnSpeechRequest uses speaker voice and section-aware instructions", () => {
  const voices = { anchor: "onyx", analyst: "coral" } as const;
  const direction = resolveTTSDirection({
    TTS_GLOBAL_STYLE: "podcast global",
    TTS_ANCHOR_STYLE: "anchor delivery",
    TTS_ANALYST_STYLE: "analyst delivery",
    TTS_STORY_STYLE: "measured story",
  });

  const anchorRequest = buildTurnSpeechRequest(
    { speaker: "anchor", text: "Here is the fact pattern." },
    voices,
    "gpt-4o-mini-tts",
    "story",
    direction,
  );
  const analystRequest = buildTurnSpeechRequest(
    { speaker: "analyst", text: "So what does that change?" },
    voices,
    "gpt-4o-mini-tts",
    "outro",
    direction,
  );

  assert.equal(anchorRequest.voice, "onyx");
  assert.equal(anchorRequest.input, "Here is the fact pattern.");
  assert.match(anchorRequest.instructions ?? "", /podcast global/);
  assert.match(anchorRequest.instructions ?? "", /anchor delivery/);
  assert.match(anchorRequest.instructions ?? "", /Section: measured story/);

  assert.equal(analystRequest.voice, "coral");
  assert.match(analystRequest.instructions ?? "", /analyst delivery/);
  assert.match(analystRequest.instructions ?? "", /Section: Warm, concise/);
});

test("buildTurnSpeechRequest rejects turns without a configured speaker voice", () => {
  assert.throws(
    () =>
      buildTurnSpeechRequest(
        { speaker: "producer", text: "This speaker is not configured." } as never,
        { anchor: "onyx", analyst: "nova" },
      ),
    /No TTS voice configured for speaker: producer/,
  );
});

test("buildConcatSpeechArgs re-encodes turn audio instead of stream-copying MP3s", () => {
  const args = buildConcatSpeechArgs(["anchor.mp3", "analyst.mp3"], "part.mp3");

  assert.deepEqual(args.slice(0, 7), [
    "-y",
    "-loglevel",
    "error",
    "-i",
    "anchor.mp3",
    "-i",
    "analyst.mp3",
  ]);
  assert.ok(args.includes("-filter_complex"));
  assert.ok(args.includes("[0:a:0][1:a:0]concat=n=2:v=0:a=1[a]"));
  assert.ok(args.includes("libmp3lame"));
  assert.equal(args.includes("-c"), false);
  assert.equal(args.includes("copy"), false);
});
