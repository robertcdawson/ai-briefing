import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildEarEditSystemPrompt } from "../src/earEdit.js";
import { buildSystemPrompt } from "../src/script.js";
import { resolveTTSDirection } from "../src/speakerProfiles.js";
import {
  EXEMPLARS_MAX,
  SHOW_CONFIG_PATH,
  TONE_NOTES_MAX,
  builtinShowConfig,
  formatListenerToneNotes,
  loadShowConfig,
  parseShowConfig,
} from "../src/showConfig.js";
import { resolveTTSProviderConfig } from "../src/ttsProvider.js";
import { HOST_IDENTITY, VOICE_EXEMPLARS } from "../src/voice.js";

test("builtin show config mirrors the host and starts with no tone notes", () => {
  const show = builtinShowConfig();
  assert.equal(show.version, 1);
  assert.equal(show.toneNotes, "");
  assert.equal(show.tts.voice, "");
  assert.equal(show.host.speech, HOST_IDENTITY.speech);
  assert.deepEqual(show.exemplars, [...VOICE_EXEMPLARS]);
  assert.equal(formatListenerToneNotes("  ", "writer"), "");
});

test("parseShowConfig overlays tone, speech, and exemplars and fills blank fields from the built-in", () => {
  const { config, truncated } = parseShowConfig({
    toneNotes: "  No rule of three.  ",
    host: { speech: "Short sentences. No performance.", humor: "   " },
    exemplars: ["  One concrete sentence.  ", ""],
    tts: { narrator: "Flat, no drawl.", voice: "  ash  " },
  });

  assert.equal(truncated, false);
  assert.equal(config.toneNotes, "No rule of three.");
  assert.equal(config.host.speech, "Short sentences. No performance.");
  assert.equal(config.host.humor, HOST_IDENTITY.humor);
  assert.deepEqual(config.exemplars, ["One concrete sentence."]);
  assert.equal(config.tts.narrator, "Flat, no drawl.");
  assert.equal(config.tts.voice, "ash");
  assert.equal(config.tts.global.length > 0, true);
});

test("parseShowConfig falls back when exemplars are empty and caps oversized notes", () => {
  const { config, truncated } = parseShowConfig({
    toneNotes: "x".repeat(TONE_NOTES_MAX + 25),
    exemplars: ["", "   "],
  });

  assert.equal(truncated, true);
  assert.equal(config.toneNotes.length, TONE_NOTES_MAX);
  assert.deepEqual(config.exemplars, [...VOICE_EXEMPLARS]);
});

test("parseShowConfig caps the exemplar list", () => {
  const exemplars = Array.from({ length: EXEMPLARS_MAX + 2 }, (_, i) => `Passage ${i} is specific.`);
  const { config, truncated } = parseShowConfig({ exemplars });
  assert.equal(truncated, true);
  assert.equal(config.exemplars.length, EXEMPLARS_MAX);
  assert.equal(config.exemplars[0], "Passage 0 is specific.");
});

test("parseShowConfig rejects a non-object", () => {
  assert.throws(() => parseShowConfig(null), /JSON object/);
  assert.throws(() => parseShowConfig(["nope"]), /JSON object/);
});

test("loadShowConfig returns the built-in show when the file is missing or invalid", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "show-config-"));
  const missing = await loadShowConfig(path.join(dir, "missing.json"));
  assert.equal(missing.host.speech, HOST_IDENTITY.speech);
  assert.equal(missing.toneNotes, "");

  const invalidPath = path.join(dir, "bad.json");
  await writeFile(invalidPath, "{", "utf8");
  const invalid = await loadShowConfig(invalidPath);
  assert.equal(invalid.host.speech, HOST_IDENTITY.speech);
});

test("loadShowConfig reads tone notes from a config file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "show-config-"));
  const filePath = path.join(dir, "show.json");
  await writeFile(filePath, JSON.stringify({ toneNotes: "Sound like a person, not a model." }), "utf8");
  const loaded = await loadShowConfig(filePath);
  assert.equal(loaded.toneNotes, "Sound like a person, not a model.");
  assert.equal(loaded.host.refusals, HOST_IDENTITY.refusals);
});

test("config/show.json on disk parses", async () => {
  const raw = await readFile(SHOW_CONFIG_PATH, "utf8");
  const { config } = parseShowConfig(JSON.parse(raw) as unknown);
  assert.equal(config.version, 1);
  assert.ok(config.host.speech.length > 0);
  assert.ok(config.exemplars.length > 0);
  assert.ok(config.tts.narrator.length > 0);
});

test("buildSystemPrompt uses show config and omits tone notes when they are empty", () => {
  const plain = buildSystemPrompt();
  assert.equal(plain.includes("LISTENER TONE NOTES"), false);
  assert.ok(plain.includes(HOST_IDENTITY.speech));

  const show = builtinShowConfig();
  show.host = { ...show.host, speech: "Talks like a tired engineer. Short sentences." };
  show.exemplars = ["One concrete sentence and then stop."];
  show.toneNotes = "No rule of three.";
  const tuned = buildSystemPrompt({ show });

  assert.match(tuned, /Talks like a tired engineer/);
  assert.match(tuned, /One concrete sentence and then stop/);
  assert.match(tuned, /LISTENER TONE NOTES/);
  assert.match(tuned, /No rule of three/);
  assert.equal(tuned.includes(HOST_IDENTITY.speech), false);
  assert.match(tuned, /They outrank the default register/);
});

test("resolveTTSDirection prefers a non-empty env style and otherwise uses the show file", () => {
  assert.equal(
    resolveTTSDirection({ TTS_NARRATOR_STYLE: "env accent" }, { narrator: "file accent" }).narrator,
    "env accent",
  );
  assert.equal(
    resolveTTSDirection({ TTS_NARRATOR_STYLE: "   " }, { narrator: "file accent" }).narrator,
    "file accent",
  );
  assert.match(resolveTTSDirection({}, { narrator: "  " }).narrator, /Southern American accent/);
});

test("resolveTTSProviderConfig lets a blank env voice fall through to the show file", () => {
  assert.equal(resolveTTSProviderConfig({ TTS_VOICE: "" }, "ash").voice, "ash");
  assert.equal(resolveTTSProviderConfig({ TTS_VOICE: "cedar" }, "ash").voice, "cedar");
  assert.equal(resolveTTSProviderConfig({ TTS_PROVIDER: "openrouter", TTS_VOICE: "" }, "Puck").voice, "Puck");
  assert.equal(
    resolveTTSProviderConfig({ TTS_PROVIDER: "openrouter", TTS_VOICE: "Charon" }, "Puck").voice,
    "Charon",
  );
});

test("buildEarEditSystemPrompt carries tone notes and the host's speech", () => {
  const plain = buildEarEditSystemPrompt();
  assert.match(plain, /How they talk/);
  assert.ok(plain.includes(HOST_IDENTITY.speech));
  assert.equal(plain.includes("LISTENER TONE NOTES"), false);

  const show = builtinShowConfig();
  show.toneNotes = "Shorter sentences.";
  const tuned = buildEarEditSystemPrompt(show);
  assert.match(tuned, /LISTENER TONE NOTES/);
  assert.match(tuned, /Shorter sentences/);
  assert.match(tuned, /Do not sand the script/);
});

test("tune page saves config/show.json and does not embed a token", async () => {
  const html = await readFile("docs/tune/index.html", "utf8");
  assert.match(html, /config\/show\.json/);
  assert.match(html, /toneNotes/);
  assert.match(html, /id="speech"/);
  assert.doesNotMatch(html, /ghp_[A-Za-z0-9]{10,}/);
  assert.doesNotMatch(html, /github_pat_[A-Za-z0-9]{10,}/);
});
