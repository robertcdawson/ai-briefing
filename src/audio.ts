import { execa } from "execa";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Episode } from "./types.js";
import { logJson, withHardTimeout, withRetry } from "./util.js";

const TIMEOUT_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;

export interface AudioResult {
  finalPath: string;
  byteLength: number;
  durationSeconds: number;
}

export async function buildEpisodeAudio(
  episode: Episode,
  segmentPaths: string[],
  workDir: string,
): Promise<AudioResult> {
  const started = Date.now();
  await mkdir(workDir, { recursive: true });

  const listPath = path.join(workDir, "concat.txt");
  const listBody = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(listPath, listBody);

  const concatPath = path.join(workDir, "concat.wav");
  await runFfmpeg(
    [
      "-y",
      "-loglevel", "error",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c:a", "pcm_s16le",
      concatPath,
    ],
    "concat",
  );

  const finalPath = path.join(workDir, `${episode.date}.mp3`);
  await runFfmpeg(
    [
      "-y",
      "-loglevel", "error",
      "-i", concatPath,
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      "-id3v2_version", "3",
      "-write_id3v1", "1",
      "-metadata", `title=${episode.title}`,
      "-metadata", "artist=AI Briefing",
      "-metadata", "album=AI Briefing",
      "-metadata", `date=${episode.date.slice(0, 4)}`,
      "-metadata", `comment=AI Briefing for ${episode.date}`,
      finalPath,
    ],
    "encode",
  );

  const stats = await stat(finalPath);
  const durationSeconds = await probeDurationSeconds(finalPath);

  logJson({
    phase: "audio",
    status: "ok",
    durationMs: Date.now() - started,
    finalPath,
    byteLength: stats.size,
    durationSeconds,
  });

  return { finalPath, byteLength: stats.size, durationSeconds };
}

async function runFfmpeg(args: string[], label: string): Promise<void> {
  await withRetry(
    () =>
      withHardTimeout(
        execa("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] }).then(() => undefined),
        TIMEOUT_MS,
        `ffmpeg.${label}`,
      ),
    { attempts: MAX_ATTEMPTS, label: `ffmpeg.${label}` },
  );
}

async function probeDurationSeconds(filePath: string): Promise<number> {
  const { stdout } = await execa(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const seconds = parseFloat(stdout.trim());
  return Number.isFinite(seconds) ? Math.round(seconds) : 0;
}
