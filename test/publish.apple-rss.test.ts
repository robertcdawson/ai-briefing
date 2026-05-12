import assert from "node:assert/strict";
import { writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { publish } from "../src/publish.js";
import type { Episode } from "../src/types.js";

const TEST_DATE = "2099-01-01";
const FEED_PATH = path.join("docs", "feed.xml");
const EPISODE_MP3_PATH = path.join("docs", "episodes", `${TEST_DATE}.mp3`);
const EPISODE_JSON_PATH = path.join("docs", "episodes", `${TEST_DATE}.json`);
const EPISODE_CHAPTERS_PATH = path.join("docs", "episodes", `${TEST_DATE}.chapters.json`);
const EPISODE_TRANSCRIPT_PATH = path.join("docs", "episodes", `${TEST_DATE}.transcript.txt`);

const originalFeed = await readFile(FEED_PATH, "utf8");
const tempAudioPath = path.join(process.cwd(), ".tmp-publish-test-audio.mp3");

process.env.FEED_BASE_URL = "https://example.com/ai-briefing";
process.env.PODCAST_OWNER_EMAIL = "owner@example.com";

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
  await publish(episode, tempAudioPath, 3, 42, [
    { kind: "intro", title: "Intro", startTime: 0, durationSeconds: 5 },
    { kind: "segment", title: "Test story", startTime: 5, durationSeconds: 27 },
    { kind: "outro", title: "Outro", startTime: 32, durationSeconds: 10 },
  ]);
  const xml = await readFile(FEED_PATH, "utf8");
  const chaptersJson = await readFile(EPISODE_CHAPTERS_PATH, "utf8");
  const transcript = await readFile(EPISODE_TRANSCRIPT_PATH, "utf8");

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
  assert.ok(
    xml.includes('xmlns:podcast="https://podcastindex.org/namespace/1.0"'),
    "feed must include the Podcasting 2.0 namespace",
  );
  assert.match(
    xml,
    /<podcast:guid>[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}<\/podcast:guid>/,
    "feed must include a stable Podcasting 2.0 show GUID",
  );
  assert.ok(
    xml.includes('<podcast:locked owner="owner@example.com">yes</podcast:locked>'),
    "feed should discourage unauthorized imports with podcast:locked",
  );
  assert.ok(
    xml.includes('<podcast:person role="host" group="cast">AI Briefing</podcast:person>'),
    "feed should declare host credits with podcast:person",
  );
  assert.ok(
    xml.includes("<itunes:season>2099</itunes:season>"),
    "daily episodes should use the publication year as the season",
  );
  assert.ok(
    xml.includes("<itunes:episode>1</itunes:episode>"),
    "daily episodes should use the day of year as the episode number",
  );
  assert.ok(
    xml.includes(
      '<podcast:chapters url="https://example.com/ai-briefing/episodes/2099-01-01.chapters.json" type="application/json+chapters"/>',
    ),
    "episodes should link to JSON chapters",
  );
  assert.ok(
    xml.includes(
      '<podcast:transcript url="https://example.com/ai-briefing/episodes/2099-01-01.transcript.txt" type="text/plain" language="en"/>',
    ),
    "episodes should link to transcript sidecars",
  );
  assert.ok(
    xml.includes('<podcast:soundbite startTime="5" duration="27">Test story</podcast:soundbite>'),
    "episodes should expose story highlights as podcast:soundbite entries",
  );
  assert.ok(
    xml.includes("00:00:05 Test story"),
    "episode descriptions should include timestamped show notes",
  );
  assert.ok(
    xml.includes("Source: https://example.com/story"),
    "episode descriptions should include source links",
  );
  assert.equal(
    xml.includes(`<itunes:image href="https://example.com/ai-briefing/episodes/${TEST_DATE}.jpg"`),
    false,
    "episode artwork should not be added yet",
  );

  assert.deepEqual(JSON.parse(chaptersJson), {
    version: "1.2.0",
    title: "AI Briefing — Jan 1, 2099",
    chapters: [
      { startTime: 0, endTime: 5, title: "Intro" },
      { startTime: 5, endTime: 32, title: "Test story" },
      { startTime: 32, endTime: 42, title: "Outro" },
    ],
  });
  assert.ok(transcript.includes("Intro\n\nIntro"), "transcript should include the intro text");
  assert.ok(transcript.includes("Test story\n\nTest script"), "transcript should include story script text");
  assert.ok(transcript.includes("Source: https://example.com/story"), "transcript should include sources");
} finally {
  await writeFile(FEED_PATH, originalFeed);
  await unlink(tempAudioPath).catch(() => {});
  await unlink(EPISODE_MP3_PATH).catch(() => {});
  await unlink(EPISODE_JSON_PATH).catch(() => {});
  await unlink(EPISODE_CHAPTERS_PATH).catch(() => {});
  await unlink(EPISODE_TRANSCRIPT_PATH).catch(() => {});
}
