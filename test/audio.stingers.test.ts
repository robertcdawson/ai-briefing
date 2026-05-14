import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execa } from "execa";
import {
  buildEpisodeAudio,
  buildFfmpegChapterMetadata,
  buildStingerSequence,
  resolveAudioCueStyle,
  resolveAudioCuesEnabled,
} from "../src/audio.js";

test("buildStingerSequence wraps segments with intro/transition/outro cues", () => {
  const sequence = buildStingerSequence(
    ["segment-00.wav", "segment-01.wav", "segment-02.wav"],
    {
      intro: "cue-intro.wav",
      transition: "cue-transition.wav",
      outro: "cue-outro.wav",
    },
  );

  assert.deepEqual(sequence, [
    "cue-intro.wav",
    "segment-00.wav",
    "cue-transition.wav",
    "segment-01.wav",
    "cue-transition.wav",
    "segment-02.wav",
    "cue-outro.wav",
  ]);
});

test("resolveAudioCuesEnabled defaults on and honors explicit disable values", () => {
  assert.equal(resolveAudioCuesEnabled(undefined), true);
  assert.equal(resolveAudioCuesEnabled("true"), true);
  assert.equal(resolveAudioCuesEnabled("FALSE"), false);
  assert.equal(resolveAudioCuesEnabled("off"), false);
  assert.equal(resolveAudioCuesEnabled("0"), false);
});

test("buildFfmpegChapterMetadata emits ID3 chapter metadata for MP3 output", () => {
  const metadata = buildFfmpegChapterMetadata([
    { kind: "intro", title: "Intro", startTime: 0, durationSeconds: 5 },
    { kind: "segment", title: "Top Story: Model = Benchmark", startTime: 5.25, durationSeconds: 126.5 },
    { kind: "outro", title: "Outro", startTime: 132, durationSeconds: 12 },
  ], 145);

  assert.match(metadata, /^;FFMETADATA1\n/);
  assert.match(metadata, /\[CHAPTER\]\nTIMEBASE=1\/1000\nSTART=0\nEND=5250\ntitle=Intro\n/);
  assert.match(metadata, /\[CHAPTER\]\nTIMEBASE=1\/1000\nSTART=5250\nEND=132000\ntitle=Model \\= Benchmark\n/);
  assert.match(metadata, /\[CHAPTER\]\nTIMEBASE=1\/1000\nSTART=132000\nEND=145000\ntitle=Outro\n/);
});

test("resolveAudioCueStyle defaults to tone and accepts supported generated cue styles", () => {
  assert.equal(resolveAudioCueStyle(undefined), "tone");
  assert.equal(resolveAudioCueStyle("CHIME"), "chime");
  assert.equal(resolveAudioCueStyle("tick"), "tick");
  assert.equal(resolveAudioCueStyle("unknown"), "tone");
});

test("buildEpisodeAudio embeds chapters that ffprobe can read from the MP3", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "ai-briefing-audio-test-"));
  const originalCuesEnabled = process.env.AUDIO_CUES_ENABLED;
  process.env.AUDIO_CUES_ENABLED = "false";

  try {
    const inputPaths = [
      path.join(workDir, "intro.mp3"),
      path.join(workDir, "story.mp3"),
      path.join(workDir, "outro.mp3"),
    ];
    await Promise.all([
      synthesizeTestTone(inputPaths[0]!, 440, 0.2),
      synthesizeTestTone(inputPaths[1]!, 550, 0.3),
      synthesizeTestTone(inputPaths[2]!, 660, 0.2),
    ]);

    const result = await buildEpisodeAudio(
      {
        date: "2099-02-02",
        title: "AI Briefing Test",
        speakers: [
          {
            id: "anchor",
            name: "The Anchor",
            role: "Host",
            persona: "Concise, skeptical, and fact-forward.",
          },
          {
            id: "analyst",
            name: "The Analyst",
            role: "Analyst",
            persona: "Warmer and practical.",
          },
        ],
        intro: [{ speaker: "anchor", text: "Intro" }],
        segments: [
          {
            title: "Top Story: Chapter Check",
            turns: [{ speaker: "analyst", text: "Story" }],
            sourceUrls: [],
          },
        ],
        outro: [{ speaker: "anchor", text: "Outro" }],
        audioPath: "",
        byteLength: 0,
        durationSeconds: 0,
      },
      inputPaths,
      workDir,
    );
    const { stdout } = await execa("ffprobe", [
      "-v", "error",
      "-show_chapters",
      "-of", "json",
      result.finalPath,
    ]);

    const parsed = JSON.parse(stdout) as { chapters?: Array<{ tags?: { title?: string } }> };
    assert.deepEqual(
      parsed.chapters?.map((chapter) => chapter.tags?.title),
      ["Intro", "Chapter Check", "Outro"],
    );
  } finally {
    if (originalCuesEnabled === undefined) {
      delete process.env.AUDIO_CUES_ENABLED;
    } else {
      process.env.AUDIO_CUES_ENABLED = originalCuesEnabled;
    }
    await rm(workDir, { recursive: true, force: true });
  }
});

async function synthesizeTestTone(
  outputPath: string,
  frequency: number,
  durationSeconds: number,
): Promise<void> {
  await execa("ffmpeg", [
    "-y",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", `sine=frequency=${frequency}:duration=${durationSeconds}`,
    "-c:a", "libmp3lame",
    outputPath,
  ]);
}
