import assert from "node:assert/strict";
import test from "node:test";
import { buildStingerSequence, resolveAudioCuesEnabled } from "../src/audio.js";

test("buildStingerSequence wraps segments with intro/transition/outro cues", () => {
  const sequence = buildStingerSequence(
    ["segment-00.wav", "segment-01.wav", "segment-02.wav"],
    {
      intro: "cue-intro.wav",
      transition: "cue-transition.wav",
      outro: "cue-outro.wav",
    },
  );

  assert.deepEqual(sequence, [
    "cue-intro.wav",
    "segment-00.wav",
    "cue-transition.wav",
    "segment-01.wav",
    "cue-transition.wav",
    "segment-02.wav",
    "cue-outro.wav",
  ]);
});

test("resolveAudioCuesEnabled defaults on and honors explicit disable values", () => {
  assert.equal(resolveAudioCuesEnabled(undefined), true);
  assert.equal(resolveAudioCuesEnabled("true"), true);
  assert.equal(resolveAudioCuesEnabled("FALSE"), false);
  assert.equal(resolveAudioCuesEnabled("off"), false);
  assert.equal(resolveAudioCuesEnabled("0"), false);
});
