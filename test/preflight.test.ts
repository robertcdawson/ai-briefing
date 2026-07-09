import assert from "node:assert/strict";
import test from "node:test";
import {
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
