import "dotenv/config";
import { execa } from "execa";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { logJson } from "../src/util.js";

/**
 * One-time generator for the show's music stinger assets.
 *
 * Generates a single ~30s music bed with Google Lyria 3 (clip preview, ~$0.04
 * per clip) via OpenRouter's chat completions audio output, then carves three
 * short cues out of it with ffmpeg:
 *
 *   assets/audio/cue-intro.mp3       (~2.6s, fade out)
 *   assets/audio/cue-transition.mp3  (~1.1s, fade in/out)
 *   assets/audio/cue-outro.mp3       (~3.2s, fade in/out)
 *
 * The full bed is kept at assets/audio/source-bed.mp3 so cues can be re-cut
 * without paying for another generation. Re-running overwrites the assets.
 * Commit the results; the pipeline picks them up with AUDIO_CUE_STYLE=asset
 * and falls back to synthesized tones when the files are missing.
 *
 * Usage: npm run stingers:generate   (requires OPENROUTER_API_KEY)
 */

const ASSET_DIR = path.join("assets", "audio");
const SOURCE_BED_PATH = path.join(ASSET_DIR, "source-bed.mp3");
const MODEL = "google/lyria-3-clip-preview";
const TIMEOUT_MS = 180_000;

const MUSIC_PROMPT =
  "Short instrumental news-podcast theme: warm analog synth pulse, light percussive ticks, " +
  "confident and modern but understated, no vocals, clean intro hit at the start and a " +
  "resolved ending, suitable for a daily AI news briefing.";

interface CueCut {
  name: "intro" | "transition" | "outro";
  startSeconds: number;
  durationSeconds: number;
}

const CUE_CUTS: CueCut[] = [
  { name: "intro", startSeconds: 0, durationSeconds: 2.6 },
  { name: "transition", startSeconds: 8, durationSeconds: 1.1 },
  { name: "outro", startSeconds: 24, durationSeconds: 3.2 },
];

async function generateMusicBed(apiKey: string): Promise<Buffer> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: MUSIC_PROMPT }],
      modalities: ["text", "audio"],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter music generation failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    choices?: { message?: { audio?: { data?: string } } }[];
    error?: { message?: string };
  };
  if (payload.error?.message) {
    throw new Error(`OpenRouter music generation error: ${payload.error.message}`);
  }
  const base64Audio = payload.choices?.[0]?.message?.audio?.data;
  if (!base64Audio) {
    throw new Error("OpenRouter music generation returned no audio data");
  }
  return Buffer.from(base64Audio, "base64");
}

async function cutCue(cut: CueCut): Promise<string> {
  const outputPath = path.join(ASSET_DIR, `cue-${cut.name}.mp3`);
  const fadeIn = cut.startSeconds > 0 ? "afade=t=in:st=0:d=0.05," : "";
  const fadeOutStart = Math.max(0, cut.durationSeconds - 0.25);
  await execa(
    "ffmpeg",
    [
      "-y",
      "-loglevel", "error",
      "-ss", cut.startSeconds.toString(),
      "-t", cut.durationSeconds.toString(),
      "-i", SOURCE_BED_PATH,
      "-af", `${fadeIn}afade=t=out:st=${fadeOutStart.toFixed(2)}:d=0.25,volume=0.5`,
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      outputPath,
    ],
    { stdio: ["ignore", "ignore", "inherit"], timeout: 60_000 },
  );
  return outputPath;
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  await mkdir(ASSET_DIR, { recursive: true });

  logJson({ phase: "stingers", status: "generating", model: MODEL });
  const bed = await generateMusicBed(apiKey);
  await writeFile(SOURCE_BED_PATH, bed);
  logJson({
    phase: "stingers",
    status: "bed_written",
    path: SOURCE_BED_PATH,
    byteLength: bed.byteLength,
  });

  for (const cut of CUE_CUTS) {
    const outputPath = await cutCue(cut);
    logJson({ phase: "stingers", status: "cue_written", cue: cut.name, path: outputPath });
  }

  logJson({
    phase: "stingers",
    status: "done",
    next: "Listen to the cues, commit assets/audio/, and set AUDIO_CUE_STYLE=asset",
  });
}

main().catch((err) => {
  logJson({
    phase: "stingers",
    status: "fatal",
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
