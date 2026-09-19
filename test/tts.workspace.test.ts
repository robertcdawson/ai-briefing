import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { synthesize } from "../src/tts.js";
import type { Episode } from "../src/types.js";

test("synthesis owns a unique private workspace and leaves preplanted symlinks untouched", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "tts-security-test-"));
  const env = { ...process.env };
  t.after(async () => {
    for (const key of ["TMPDIR", "TMP", "TEMP", "TTS_PROVIDER", "OPENAI_API_KEY"]) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    await rm(root, { recursive: true, force: true });
  });
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = root;
  process.env.TTS_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  t.mock.method(OpenAI.Audio.Speech.prototype, "create", async () => new Response("mock audio"));
  const ep: Episode = {
    date: "2026-09-19", title: "Test", intro: ["Intro"], outro: ["Outro"],
    segments: [{ title: "Story", chunks: ["Story text"], sourceUrls: [] }],
    audioPath: "", byteLength: 0, durationSeconds: 0,
  };
  const oldDir = path.join(root, `ai-briefing-${ep.date}-${process.pid}`);
  await mkdir(oldDir);
  const victim = path.join(root, "victim.txt");
  await writeFile(victim, "untouched");
  await symlink(victim, path.join(oldDir, "00-intro.mp3"));

  const first = await synthesize(ep);
  assert.equal(await readFile(victim, "utf8"), "untouched");
  const second = await synthesize(ep);
  assert.notEqual(first.segmentDir, second.segmentDir);
  for (const result of [first, second]) {
    assert.notEqual(result.segmentDir, oldDir);
    assert.equal(path.dirname(result.segmentDir), root);
    assert.equal((await stat(result.segmentDir)).mode & 0o077, 0);
    assert.equal(result.segmentPaths.length, 3);
    for (const file of result.segmentPaths) {
      assert.equal(path.dirname(file), result.segmentDir);
      assert.equal(await readFile(file, "utf8"), "mock audio");
    }
  }
  assert.deepEqual(await readdir(oldDir), ["00-intro.mp3"]);
  const beforeFailure = (await readdir(root)).sort();
  await assert.rejects(synthesize({ ...ep, intro: [] }), /no narration chunks/);
  assert.deepEqual((await readdir(root)).sort(), beforeFailure, "failed synthesis removes only its own workspace");
});
