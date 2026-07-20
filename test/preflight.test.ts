import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPreflight,
  buildEnvironmentPreflightChecks,
  runPreflight,
} from "../src/preflight.js";

test("environment preflight reports missing values that would fail after paid stages", () => {
  const checks = buildEnvironmentPreflightChecks({});
  const failures = checks.filter((check) => check.status === "error");

  assert.deepEqual(
    failures.map((check) => check.name),
    ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "FEED_BASE_URL"],
  );
});

test("environment preflight accepts the default OpenAI TTS route when required keys are set", () => {
  const checks = buildEnvironmentPreflightChecks({
    OPENROUTER_API_KEY: "openrouter-key",
    OPENAI_API_KEY: "openai-key",
    FEED_BASE_URL: "https://example.com/ai-briefing",
  });

  assert.equal(checks.every((check) => check.status === "ok"), true);
});

test("environment preflight does not require OpenAI when OpenRouter handles TTS", () => {
  const checks = buildEnvironmentPreflightChecks({
    OPENROUTER_API_KEY: "openrouter-key",
    TTS_PROVIDER: "openrouter",
    FEED_BASE_URL: "https://example.com/ai-briefing",
  });

  assert.equal(checks.every((check) => check.status === "ok"), true);
});

test("environment preflight rejects non-http feed base URLs", () => {
  const checks = buildEnvironmentPreflightChecks({
    OPENROUTER_API_KEY: "openrouter-key",
    OPENAI_API_KEY: "openai-key",
    FEED_BASE_URL: "ftp://example.com/ai-briefing",
  });

  const feedCheck = checks.find((check) => check.name === "FEED_BASE_URL");
  assert.equal(feedCheck?.status, "error");
  assert.match(feedCheck?.message ?? "", /https?:\/\//);
});

test("runPreflight includes ffmpeg and ffprobe availability checks", async () => {
  const result = await runPreflight({
    env: {
      OPENROUTER_API_KEY: "openrouter-key",
      OPENAI_API_KEY: "openai-key",
      FEED_BASE_URL: "https://example.com/ai-briefing",
    },
    commandExists: async (command) => command === "ffmpeg",
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.name === "ffmpeg")?.status, "ok");
  assert.equal(result.checks.find((check) => check.name === "ffprobe")?.status, "error");
});

test("assertPreflight rejects with actionable failures before paid stages", async () => {
  await assert.rejects(
    assertPreflight({
      env: {
        TTS_PROVIDER: "openrouter",
        FEED_BASE_URL: "not-a-url",
      },
      commandExists: async () => false,
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^Pipeline preflight failed:/);
      assert.match(error.message, /OPENROUTER_API_KEY is not set \(required for curation\)/);
      assert.equal(
        error.message.split("\n").filter((line) => line.startsWith("- OPENROUTER_API_KEY:")).length,
        1,
      );
      assert.equal(error.message.includes("OPENAI_API_KEY"), false);
      assert.match(error.message, /FEED_BASE_URL must be an absolute http\(s\) URL/);
      assert.match(error.message, /ffmpeg must be installed and available on PATH/);
      assert.match(error.message, /ffprobe must be installed and available on PATH/);
      return true;
    },
  );
});
