import assert from "node:assert/strict";
import test from "node:test";
import {
  stripInlineAudioTags,
  supportsInlineAudioTags,
} from "../src/audioTags.js";
import { DEFAULT_GEMINI_TTS_MODEL } from "../src/geminiTts.js";
import {
  DEFAULT_OPENAI_TTS_MODEL,
  DEFAULT_OPENROUTER_TTS_MODEL,
  DEFAULT_OPENROUTER_TTS_VOICE,
  OPENROUTER_TTS_BASE_URL,
  resolveTTSProvider,
  resolveTTSProviderConfig,
} from "../src/ttsProvider.js";

test("resolveTTSProvider defaults to openai and accepts openrouter", () => {
  assert.equal(resolveTTSProvider({}), "openai");
  assert.equal(resolveTTSProvider({ TTS_PROVIDER: "openai" }), "openai");
  assert.equal(resolveTTSProvider({ TTS_PROVIDER: " OpenRouter " }), "openrouter");
  assert.equal(resolveTTSProvider({ TTS_PROVIDER: "unknown" }), "openai");
});

test("resolveTTSProviderConfig keeps the OpenAI defaults stable", () => {
  const config = resolveTTSProviderConfig({});

  assert.equal(config.provider, "openai");
  assert.equal(config.model, DEFAULT_OPENAI_TTS_MODEL);
  assert.equal(config.voice, "cedar");
  assert.equal(config.baseURL, undefined);
  assert.equal(config.apiKeyEnvVar, "OPENAI_API_KEY");
  assert.equal(config.supportsDeliveryInstructions, true);
  assert.equal(config.supportsInlineAudioTags, false);
  assert.equal(config.maxRequestChars, 4096);
});

test("resolveTTSProviderConfig disables instructions for legacy OpenAI models", () => {
  const config = resolveTTSProviderConfig({ TTS_MODEL: "tts-1-hd" });

  assert.equal(config.model, "tts-1-hd");
  assert.equal(config.supportsDeliveryInstructions, false);
});

test("resolveTTSProviderConfig falls back to the OpenAI default for unknown OpenAI models", () => {
  const config = resolveTTSProviderConfig({ TTS_MODEL: "not-a-model" });

  assert.equal(config.model, DEFAULT_OPENAI_TTS_MODEL);
});

test("resolveTTSProviderConfig routes openrouter to its base URL, key, and Gemini default", () => {
  const config = resolveTTSProviderConfig({ TTS_PROVIDER: "openrouter" });

  assert.equal(config.provider, "openrouter");
  assert.equal(config.model, DEFAULT_OPENROUTER_TTS_MODEL);
  assert.equal(config.voice, DEFAULT_OPENROUTER_TTS_VOICE);
  assert.equal(config.baseURL, OPENROUTER_TTS_BASE_URL);
  assert.equal(config.apiKeyEnvVar, "OPENROUTER_API_KEY");
  assert.equal(config.supportsDeliveryInstructions, false);
  assert.equal(config.supportsInlineAudioTags, true);
  assert.equal(config.maxRequestChars, 8000);
});

test("resolveTTSProviderConfig routes a designed voice id to the Gemini API", () => {
  const config = resolveTTSProviderConfig({ TTS_VOICE: "" }, "voice_1hd8ebzfhu1g");

  assert.equal(config.provider, "gemini");
  assert.equal(config.model, DEFAULT_GEMINI_TTS_MODEL);
  assert.equal(config.voice, "voice_1hd8ebzfhu1g");
  assert.equal(config.apiKeyEnvVar, "GEMINI_API_KEY");
  assert.equal(config.supportsDeliveryInstructions, false);
  assert.equal(config.supportsInlineAudioTags, false);
  assert.equal(config.maxRequestChars, 8000);
});

test("resolveTTSProviderConfig lets an explicit provider win over a designed voice id", () => {
  assert.equal(
    resolveTTSProvider({ TTS_PROVIDER: "openai" }, "voice_1hd8ebzfhu1g"),
    "openai",
  );
  const config = resolveTTSProviderConfig(
    { TTS_PROVIDER: "gemini", TTS_MODEL: "gpt-4o-mini-tts", TTS_VOICE: "Kore" },
    "voice_1hd8ebzfhu1g",
  );
  assert.equal(config.provider, "gemini");
  assert.equal(config.model, DEFAULT_GEMINI_TTS_MODEL);
  assert.equal(config.voice, "Kore");
});

test("resolveTTSProviderConfig honors a non-OpenAI Gemini model override", () => {
  const config = resolveTTSProviderConfig({
    TTS_PROVIDER: "gemini",
    TTS_MODEL: "gemini-3.8-flash-lite-tts",
  });

  assert.equal(config.model, "gemini-3.8-flash-lite-tts");
  assert.equal(config.voice, DEFAULT_OPENROUTER_TTS_VOICE);
});

test("resolveTTSProviderConfig honors openrouter model and voice overrides", () => {
  const config = resolveTTSProviderConfig({
    TTS_PROVIDER: "openrouter",
    TTS_MODEL: " microsoft/mai-voice-2 ",
    TTS_VOICE: " en-US-Harper:MAI-Voice-2 ",
  });

  assert.equal(config.model, "microsoft/mai-voice-2");
  assert.equal(config.voice, "en-US-Harper:MAI-Voice-2");
  assert.equal(config.supportsInlineAudioTags, false);
});

test("supportsInlineAudioTags detects Gemini TTS model ids only", () => {
  assert.equal(supportsInlineAudioTags("google/gemini-3.1-flash-tts-preview"), true);
  assert.equal(supportsInlineAudioTags("google/gemini-2.5-flash-tts"), true);
  assert.equal(supportsInlineAudioTags("gpt-4o-mini-tts"), false);
  assert.equal(supportsInlineAudioTags("google/gemini-3.1-pro-preview"), false);
  assert.equal(supportsInlineAudioTags("microsoft/mai-voice-2"), false);
});

test("stripInlineAudioTags removes only approved tags and tidies spacing", () => {
  assert.equal(
    stripInlineAudioTags("[skeptical] The demo numbers look suspicious."),
    "The demo numbers look suspicious.",
  );
  assert.equal(
    stripInlineAudioTags("One beat. [chuckles] Another beat."),
    "One beat. Another beat.",
  );
  assert.equal(
    stripInlineAudioTags("Scores rose [from the paper] across the board."),
    "Scores rose [from the paper] across the board.",
  );
  assert.equal(stripInlineAudioTags("No tags at all."), "No tags at all.");
});
