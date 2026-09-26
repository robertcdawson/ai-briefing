import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execa } from "execa";
import {
  GEMINI_TTS_URL,
  buildGeminiInteractionBody,
  buildGeminiSpeechStyle,
  extractGeminiAudioBase64,
  writeGeminiSpeechMp3,
} from "../src/geminiTts.js";
import { resolveTTSDirection } from "../src/speakerProfiles.js";

test("buildGeminiSpeechStyle keeps delivery out of the transcript", () => {
  const style = buildGeminiSpeechStyle(
    "story",
    resolveTTSDirection({
      TTS_NARRATOR_STYLE: "soft Southern drawl",
      TTS_STORY_STYLE: "measured and clear",
    }),
    "flat — let the number speak",
  );

  assert.equal(style, "soft Southern drawl measured and clear flat — let the number speak");
});

test("buildGeminiInteractionBody sends the voice id and style beside the verbatim transcript", () => {
  const body = buildGeminiInteractionBody({
    model: "gemini-3.8-flash-tts",
    voice: "voice_1hd8ebzfhu1g",
    text: "The price doubled.",
    style: "soft Southern drawl",
  });

  assert.equal(body.model, "gemini-3.8-flash-tts");
  const input = body.input as Array<{ content: Array<Record<string, unknown>> }>;
  const textPart = input[0]?.content[0];
  assert.equal(textPart?.text, "The price doubled.");
  assert.deepEqual(textPart?.annotations, [{ type: "speech_metadata", style: "soft Southern drawl" }]);
  const generation = body.generation_config as { speech_config: Array<{ voice: string }> };
  assert.equal(generation.speech_config[0]?.voice, "voice_1hd8ebzfhu1g");
});

test("extractGeminiAudioBase64 reads the last model audio step", () => {
  assert.equal(
    extractGeminiAudioBase64({
      steps: [
        { type: "model_output", content: [{ type: "text", text: "ignored" }] },
        { type: "model_output", content: [{ type: "audio", data: "abc" }, { type: "audio", data: "wav" }] },
      ],
    }),
    "wav",
  );
  assert.throws(() => extractGeminiAudioBase64({ steps: [] }), /did not include audio/);
});

test("writeGeminiSpeechMp3 posts the designed voice and writes an mp3 without leaking the key", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "ai-briefing-gemini-tts-"));
  const outputPath = path.join(workDir, "part.mp3");
  const apiKey = "super-secret-gemini-key";

  try {
    await writeGeminiSpeechMp3({
      apiKey,
      timeoutMs: 5_000,
      label: "00-intro",
      outputPath,
      speech: {
        model: "gemini-3.8-flash-tts",
        voice: "voice_1hd8ebzfhu1g",
        text: "The price doubled.",
        style: "soft Southern drawl",
      },
      fetchImpl: async (url, init) => {
        assert.equal(url, GEMINI_TTS_URL);
        assert.equal(new Headers(init?.headers).get("x-goog-api-key"), apiKey);
        const body = JSON.parse(String(init?.body)) as {
          generation_config: { speech_config: Array<{ voice: string }> };
          input: Array<{ content: Array<{ text: string }> }>;
        };
        assert.equal(body.generation_config.speech_config[0]?.voice, "voice_1hd8ebzfhu1g");
        assert.equal(body.input[0]?.content[0]?.text, "The price doubled.");
        return new Response(
          JSON.stringify({
            steps: [{ type: "model_output", content: [{ type: "audio", data: tinyWavBase64() }] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const { stdout } = await execa("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      outputPath,
    ]);
    assert.ok(parseFloat(stdout.trim()) > 0);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  await assert.rejects(
    () =>
      writeGeminiSpeechMp3({
        apiKey,
        timeoutMs: 5_000,
        label: "00-intro",
        outputPath,
        speech: { model: "gemini-3.8-flash-tts", voice: "voice_1hd8ebzfhu1g", text: "Hello." },
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: `denied for ${apiKey}` } }), { status: 400 }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 400/);
      assert.equal(error.message.includes(apiKey), false);
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
});

function tinyWavBase64(): string {
  const sampleRate = 24_000;
  const numSamples = sampleRate / 10;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer.toString("base64");
}
