import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hasPublishedEpisode } from "../src/publish.js";

async function makeTempEpisodesDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "publish-already-"));
  for (const [filename, content] of Object.entries(files)) {
    await writeFile(path.join(dir, filename), content, "utf8");
  }
  return dir;
}

test("hasPublishedEpisode is true only when both sidecar and mp3 exist", async () => {
  const dir = await makeTempEpisodesDir({
    "2026-07-28.json": "{}",
    "2026-07-28.mp3": "audio",
  });
  try {
    assert.equal(await hasPublishedEpisode("2026-07-28", dir), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hasPublishedEpisode is false when the mp3 is missing", async () => {
  const dir = await makeTempEpisodesDir({
    "2026-07-28.json": "{}",
  });
  try {
    assert.equal(await hasPublishedEpisode("2026-07-28", dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hasPublishedEpisode is false when the sidecar is missing", async () => {
  const dir = await makeTempEpisodesDir({
    "2026-07-28.mp3": "audio",
  });
  try {
    assert.equal(await hasPublishedEpisode("2026-07-28", dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hasPublishedEpisode is false for an empty episodes directory", async () => {
  const dir = await makeTempEpisodesDir({});
  try {
    assert.equal(await hasPublishedEpisode("2026-07-28", dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
