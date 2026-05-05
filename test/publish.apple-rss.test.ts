import assert from "node:assert/strict";
import { writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { publish } from "../src/publish.js";
import type { Episode } from "../src/types.js";

const TEST_DATE = "2099-01-01";
const FEED_PATH = path.join("docs", "feed.xml");
const EPISODE_MP3_PATH = path.join("docs", "episodes", `${TEST_DATE}.mp3`);
const EPISODE_JSON_PATH = path.join("docs", "episodes", `${TEST_DATE}.json`);

const originalFeed = await readFile(FEED_PATH, "utf8");
const tempAudioPath = path.join(process.cwd(), ".tmp-publish-test-audio.mp3");

process.env.FEED_BASE_URL = "https://example.com/ai-briefing";

const episode: Episode = {
  date: TEST_DATE,
  title: "AI Briefing — Jan 1, 2099",
  intro: "Intro",
  segments: [
    {
      title: "Test story",
      script: "Test script",
      sourceUrls: ["https://example.com/story"],
    },
  ],
  outro: "Outro",
  audioPath: "",
  byteLength: 0,
  durationSeconds: 0,
};

try {
  await writeFile(tempAudioPath, Buffer.from([0x49, 0x44, 0x33]));
  await publish(episode, tempAudioPath, 3, 42);
  const xml = await readFile(FEED_PATH, "utf8");

  assert.ok(
    xml.includes("<itunes:owner>"),
    "feed must include <itunes:owner> for Apple Podcasts contact metadata",
  );
  assert.ok(
    xml.includes("<itunes:image href="),
    "feed must include channel artwork via <itunes:image>",
  );
  assert.ok(
    xml.includes("<itunes:category text="),
    "feed must include at least one <itunes:category>",
  );
  assert.ok(
    xml.includes("<itunes:type>episodic</itunes:type>"),
    "feed must declare episodic podcast type for Apple Podcasts",
  );
  assert.ok(
    xml.includes("<itunes:episodeType>full</itunes:episodeType>"),
    "each episode should declare a full episode type",
  );
} finally {
  await writeFile(FEED_PATH, originalFeed);
  await unlink(tempAudioPath).catch(() => {});
  await unlink(EPISODE_MP3_PATH).catch(() => {});
  await unlink(EPISODE_JSON_PATH).catch(() => {});
}
