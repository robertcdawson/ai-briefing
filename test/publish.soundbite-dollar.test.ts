import assert from "node:assert/strict";
import { writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { publish } from "../src/publish.js";
import type { Episode } from "../src/types.js";

const TEST_DATE = "2099-06-15";
const FEED_PATH = path.join("docs", "feed.xml");
const EPISODE_MP3_PATH = path.join("docs", "episodes", `${TEST_DATE}.mp3`);
const EPISODE_JSON_PATH = path.join("docs", "episodes", `${TEST_DATE}.json`);
const EPISODE_CHAPTERS_PATH = path.join("docs", "episodes", `${TEST_DATE}.chapters.json`);
const EPISODE_TRANSCRIPT_PATH = path.join("docs", "episodes", `${TEST_DATE}.transcript.txt`);

const originalFeed = await readFile(FEED_PATH, "utf8");
const tempAudioPath = path.join(process.cwd(), ".tmp-publish-dollar-test-audio.mp3");

process.env.FEED_BASE_URL = "https://example.com/ai-briefing";
process.env.PODCAST_OWNER_EMAIL = "owner@example.com";

const episode: Episode = {
  date: TEST_DATE,
  title: "AI Briefing — Jun 15, 2099",
  intro: ["Intro"],
  segments: [
    {
      title: "Top Story: Court approves landmark $1.5 billion settlement",
      chunks: ["Settlement details."],
      sourceUrls: ["https://example.com/settlement"],
    },
  ],
  outro: ["Outro"],
  audioPath: "",
  byteLength: 0,
  durationSeconds: 0,
};

try {
  await writeFile(tempAudioPath, Buffer.from([0x49, 0x44, 0x33]));
  await publish(
    episode,
    tempAudioPath,
    3,
    60,
    [
      { kind: "intro", title: "Intro", startTime: 0, durationSeconds: 5 },
      {
        kind: "segment",
        title: "Top Story: Court approves landmark $1.5 billion settlement",
        startTime: 5,
        durationSeconds: 45,
      },
      { kind: "outro", title: "Outro", startTime: 50, durationSeconds: 10 },
    ],
  );
  const xml = await readFile(FEED_PATH, "utf8");

  assert.match(
    xml,
    /<podcast:soundbite startTime="5" duration="45">Court approves landmark \$1\.5 billion\.\.\.<\/podcast:soundbite>/,
    "soundbite titles with $1 must remain literal currency text",
  );
  assert.equal(
    xml.includes("<podcast:soundbite startTime=\"5\" duration=\"45\">Court approves landmark <guid>"),
    false,
    "soundbite must not expand $1 as a regex replacement backreference",
  );
  // Element-local check: a soundbite's own text node must not contain nested tags.
  const soundbiteBodies = [...xml.matchAll(/<podcast:soundbite\b[^>]*>(.*?)<\/podcast:soundbite>/gs)].map(
    (match) => match[1] ?? "",
  );
  assert.ok(soundbiteBodies.length > 0, "expected at least one soundbite");
  assert.equal(
    soundbiteBodies.some((body) => body.includes("<")),
    false,
    "no soundbite body may contain nested XML from $N expansion",
  );
} finally {
  await writeFile(FEED_PATH, originalFeed);
  await unlink(tempAudioPath).catch(() => {});
  await unlink(EPISODE_MP3_PATH).catch(() => {});
  await unlink(EPISODE_JSON_PATH).catch(() => {});
  await unlink(EPISODE_CHAPTERS_PATH).catch(() => {});
  await unlink(EPISODE_TRANSCRIPT_PATH).catch(() => {});
}
