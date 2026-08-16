import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execa } from "execa";
import {
  buildChunkSpeechRequest,
  buildConcatSpeechArgs,
  buildPartSpeechRequest,
  buildSpeechRequest,
  CHUNK_GAP_SECONDS,
  DEFAULT_GLOBAL_TTS_STYLE,
  resolveNarratorVoice,
  resolveTTSDirection,
  resolveTTSTimeoutMs,
  type TTSProviderConfig,
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

test("buildConcatSpeechArgs re-encodes chunk audio with breathing gaps between chunks", () => {
  const args = buildConcatSpeechArgs(["01.mp3", "02.mp3", "03.mp3"], "part.mp3");

  assert.deepEqual(args.slice(0, 9), [
    "-y",
    "-loglevel",
    "error",
    "-i",
    "01.mp3",
    "-i",
    "02.mp3",
    "-i",
    "03.mp3",
  ]);
  assert.ok(args.includes("-filter_complex"));
  assert.ok(
    args.includes(
      `[0:a:0]apad=pad_dur=${CHUNK_GAP_SECONDS}[p0];` +
        `[1:a:0]apad=pad_dur=${CHUNK_GAP_SECONDS}[p1];` +
        "[p0][p1][2:a:0]concat=n=3:v=0:a=1[a]",
    ),
  );
  assert.ok(args.includes("libmp3lame"));
  assert.equal(args.includes("-c"), false);
  assert.equal(args.includes("copy"), false);
});

test("buildConcatSpeechArgs produces ffmpeg-valid filters that add the gap", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "ai-briefing-tts-concat-test-"));
  try {
    const inputs = [path.join(workDir, "01.mp3"), path.join(workDir, "02.mp3")];
    for (const [index, input] of inputs.entries()) {
      await execa("ffmpeg", [
        "-y", "-loglevel", "error",
        "-f", "lavfi",
        "-i", `sine=frequency=${440 + index * 110}:duration=0.3`,
        "-c:a", "libmp3lame",
        input,
      ]);
    }
    const outputPath = path.join(workDir, "part.mp3");

    await execa("ffmpeg", buildConcatSpeechArgs(inputs, outputPath));

    const { stdout } = await execa("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      outputPath,
    ]);
    const durationSeconds = parseFloat(stdout.trim());
    assert.ok(
      durationSeconds >= 0.3 + CHUNK_GAP_SECONDS + 0.3,
      `concat output should include the ${CHUNK_GAP_SECONDS}s gap, got ${durationSeconds}s`,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("buildPartSpeechRequest joins chunks into one continuous monologue", () => {
  const config: TTSProviderConfig = {
    provider: "openai",
    model: "gpt-4o-mini-tts",
    voice: "marin",
    apiKeyEnvVar: "OPENAI_API_KEY",
    supportsDeliveryInstructions: true,
    supportsInlineAudioTags: false,
    maxRequestChars: 4096,
  };
  const direction = resolveTTSDirection({ TTS_STORY_STYLE: "measured story" });

  const request = buildPartSpeechRequest(
    ["First beat of the story. ", "", "Second beat lands here."],
    config,
    "story",
    direction,
  );

  assert.equal(request.model, "gpt-4o-mini-tts");
  assert.equal(request.voice, "marin");
  assert.equal(request.input, "First beat of the story.\n\nSecond beat lands here.");
  assert.match(request.instructions ?? "", /Section: measured story/);
});

test("buildPartSpeechRequest strips inline tags for models that would read them aloud", () => {
  const config: TTSProviderConfig = {
    provider: "openai",
    model: "gpt-4o-mini-tts",
    voice: "marin",
    apiKeyEnvVar: "OPENAI_API_KEY",
    supportsDeliveryInstructions: true,
    supportsInlineAudioTags: false,
    maxRequestChars: 4096,
  };

  const request = buildPartSpeechRequest(
    ["[skeptical] The demo numbers look suspicious."],
    config,
  );

  assert.equal(request.input, "The demo numbers look suspicious.");
});

test("buildPartSpeechRequest keeps inline tags and omits instructions for expressive OpenRouter models", () => {
  const config: TTSProviderConfig = {
    provider: "openrouter",
    model: "google/gemini-3.1-flash-tts-preview",
    voice: "Charon",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    supportsDeliveryInstructions: false,
    supportsInlineAudioTags: true,
    maxRequestChars: 8000,
  };

  const request = buildPartSpeechRequest(
    ["[skeptical] The demo numbers look suspicious."],
    config,
  );

  assert.equal(request.model, "google/gemini-3.1-flash-tts-preview");
  assert.equal(request.voice, "Charon");
  assert.equal(request.input, "[skeptical] The demo numbers look suspicious.");
  assert.equal(request.instructions, undefined);
});

test("buildPartSpeechRequest includes a per-segment delivery hint on the OpenAI path", () => {
  const config: TTSProviderConfig = {
    provider: "openai",
    model: "gpt-4o-mini-tts",
    voice: "marin",
    apiKeyEnvVar: "OPENAI_API_KEY",
    supportsDeliveryInstructions: true,
    supportsInlineAudioTags: false,
    maxRequestChars: 4096,
  };

  const request = buildPartSpeechRequest(
    ["The number speaks for itself."],
    config,
    "story",
    resolveTTSDirection({ TTS_STORY_STYLE: "measured story" }),
    "flat — let the number speak",
  );

  assert.match(request.instructions ?? "", /This segment: flat — let the number speak/);
});

test("buildPartSpeechRequest ignores a delivery hint on the OpenRouter path (instructions stays undefined)", () => {
  const config: TTSProviderConfig = {
    provider: "openrouter",
    model: "google/gemini-3.1-flash-tts-preview",
    voice: "Charon",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    supportsDeliveryInstructions: false,
    supportsInlineAudioTags: true,
    maxRequestChars: 8000,
  };

  const request = buildPartSpeechRequest(
    ["The number speaks for itself."],
    config,
    "story",
    resolveTTSDirection(),
    "flat — let the number speak",
  );

  assert.equal(request.instructions, undefined);
});
