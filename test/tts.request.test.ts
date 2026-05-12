import assert from "node:assert/strict";
import test from "node:test";
import { buildSpeechRequest, TTS_DELIVERY_INSTRUCTIONS } from "../src/tts.js";

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
