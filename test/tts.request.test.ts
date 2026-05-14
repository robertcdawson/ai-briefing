import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConcatSpeechArgs,
  buildSpeechRequest,
  buildTurnSpeechRequest,
  resolveSpeakerVoices,
  resolveTTSTimeoutMs,
  TTS_DELIVERY_INSTRUCTIONS,
  TTS_DELIVERY_INSTRUCTIONS_BY_SPEAKER,
} from "../src/tts.js";

test("buildSpeechRequest adds enthusiastic delivery instructions for instructable TTS models", () => {
  const request = buildSpeechRequest("Short podcast intro.", "onyx", "gpt-4o-mini-tts");

  assert.equal(request.model, "gpt-4o-mini-tts");
  assert.equal(request.response_format, "mp3");
  assert.equal(request.instructions, TTS_DELIVERY_INSTRUCTIONS);
  assert.match(request.instructions ?? "", /enthusiastic, sharp AI news podcast host/);
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

test("resolveSpeakerVoices chooses per-speaker voices with safe defaults", () => {
  assert.deepEqual(resolveSpeakerVoices({}), { anchor: "onyx", analyst: "nova" });
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
      TTS_ANCHOR_VOICE: "cedar",
      TTS_ANALYST_VOICE: "also-invalid",
    }),
    { anchor: "cedar", analyst: "nova" },
  );
});

test("buildTurnSpeechRequest uses each turn speaker's configured voice and persona instructions", () => {
  const voices = { anchor: "onyx", analyst: "coral" } as const;

  const anchorRequest = buildTurnSpeechRequest(
    { speaker: "anchor", text: "Here is the fact pattern." },
    voices,
    "gpt-4o-mini-tts",
  );
  const analystRequest = buildTurnSpeechRequest(
    { speaker: "analyst", text: "So what does that change?" },
    voices,
    "gpt-4o-mini-tts",
  );

  assert.equal(anchorRequest.voice, "onyx");
  assert.equal(anchorRequest.input, "Here is the fact pattern.");
  assert.equal(anchorRequest.instructions, TTS_DELIVERY_INSTRUCTIONS_BY_SPEAKER.anchor);
  assert.match(anchorRequest.instructions ?? "", /The Anchor is concise/);

  assert.equal(analystRequest.voice, "coral");
  assert.equal(analystRequest.input, "So what does that change?");
  assert.equal(analystRequest.instructions, TTS_DELIVERY_INSTRUCTIONS_BY_SPEAKER.analyst);
  assert.match(analystRequest.instructions ?? "", /The Analyst is warmer/);
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
