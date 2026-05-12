import { execa } from "execa";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Episode, EpisodePartTiming } from "./types.js";
import { logJson, withHardTimeout, withRetry } from "./util.js";

const TIMEOUT_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const TARGET_SAMPLE_RATE = "44100";
const TARGET_CHANNELS = "2";

interface CueTrackPaths {
  intro: string;
  transition: string;
  outro: string;
}

export interface AudioResult {
  finalPath: string;
  byteLength: number;
  durationSeconds: number;
  partTimings: EpisodePartTiming[];
}

export async function buildEpisodeAudio(
  episode: Episode,
  segmentPaths: string[],
  workDir: string,
): Promise<AudioResult> {
  const started = Date.now();
  await mkdir(workDir, { recursive: true });
  if (segmentPaths.length === 0) {
    throw new Error("buildEpisodeAudio: no segment paths provided");
  }
  const expectedParts = episode.segments.length + 2;
  if (segmentPaths.length !== expectedParts) {
    throw new Error(
      `buildEpisodeAudio: received ${segmentPaths.length} segment path(s), expected ${expectedParts}`,
    );
  }

  const normalizedSegments = await normalizeSegmentAudio(segmentPaths, workDir);
  const segmentDurations = await Promise.all(normalizedSegments.map((filePath) => probeDuration(filePath)));
  const cuesEnabled = resolveAudioCuesEnabled();
  const cueTracks = cuesEnabled ? await synthesizeCueTracks(workDir) : null;
  const cueDurations = cueTracks
    ? {
        intro: await probeDuration(cueTracks.intro),
        transition: await probeDuration(cueTracks.transition),
        outro: await probeDuration(cueTracks.outro),
      }
    : { intro: 0, transition: 0, outro: 0 };
  const concatInputs = cueTracks
    ? buildStingerSequence(normalizedSegments, cueTracks)
    : normalizedSegments;
  const concatPath = await concatAudioFiles(concatInputs, workDir, "program");

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
  const partTimings = buildEpisodePartTimings(episode, segmentDurations, cueDurations, cuesEnabled);

  logJson({
    phase: "audio",
    status: "ok",
    durationMs: Date.now() - started,
    finalPath,
    byteLength: stats.size,
    durationSeconds,
    cuesEnabled,
  });

  return { finalPath, byteLength: stats.size, durationSeconds, partTimings };
}

export function resolveAudioCuesEnabled(value = process.env.AUDIO_CUES_ENABLED): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

export function buildStingerSequence(
  normalizedSegments: string[],
  cueTracks: CueTrackPaths,
): string[] {
  const [firstSegment, ...remainingSegments] = normalizedSegments;
  if (!firstSegment) return [];

  const sequence: string[] = [cueTracks.intro, firstSegment];
  for (const segment of remainingSegments) {
    sequence.push(cueTracks.transition, segment);
  }
  sequence.push(cueTracks.outro);
  return sequence;
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

async function normalizeSegmentAudio(segmentPaths: string[], workDir: string): Promise<string[]> {
  const normalized: string[] = [];
  for (const [index, segmentPath] of segmentPaths.entries()) {
    const outputPath = path.join(workDir, `segment-${pad2(index)}.wav`);
    await runFfmpeg(
      [
        "-y",
        "-loglevel", "error",
        "-i", segmentPath,
        "-c:a", "pcm_s16le",
        "-ar", TARGET_SAMPLE_RATE,
        "-ac", TARGET_CHANNELS,
        outputPath,
      ],
      `normalize.${index}`,
    );
    normalized.push(outputPath);
  }
  return normalized;
}

async function concatAudioFiles(inputs: string[], workDir: string, outputStem: string): Promise<string> {
  const listPath = path.join(workDir, `${outputStem}.txt`);
  const listBody = inputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(listPath, listBody);

  const outputPath = path.join(workDir, `${outputStem}.wav`);
  await runFfmpeg(
    [
      "-y",
      "-loglevel", "error",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c:a", "pcm_s16le",
      outputPath,
    ],
    `${outputStem}.concat`,
  );
  return outputPath;
}

async function synthesizeCueTracks(workDir: string): Promise<CueTrackPaths> {
  const intro = path.join(workDir, "cue-intro.wav");
  const transition = path.join(workDir, "cue-transition.wav");
  const outro = path.join(workDir, "cue-outro.wav");

  await Promise.all([
    synthesizeCueTone(intro, 1046.5, 0.22, "intro"),
    synthesizeCueTone(transition, 880, 0.16, "transition"),
    synthesizeCueTone(outro, 659.25, 0.28, "outro"),
  ]);

  return { intro, transition, outro };
}

async function synthesizeCueTone(
  outputPath: string,
  frequency: number,
  durationSeconds: number,
  label: string,
): Promise<void> {
  const fadeOutStart = Math.max(0, durationSeconds - 0.04);
  await runFfmpeg(
    [
      "-y",
      "-loglevel", "error",
      "-f", "lavfi",
      "-i", `sine=frequency=${frequency}:sample_rate=${TARGET_SAMPLE_RATE}:duration=${durationSeconds}`,
      "-af",
      `volume=0.10,afade=t=in:st=0:d=0.015,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.04`,
      "-c:a", "pcm_s16le",
      "-ar", TARGET_SAMPLE_RATE,
      "-ac", TARGET_CHANNELS,
      outputPath,
    ],
    `cue.${label}`,
  );
}

async function probeDurationSeconds(filePath: string): Promise<number> {
  return Math.round(await probeDuration(filePath));
}

async function probeDuration(filePath: string): Promise<number> {
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
  return Number.isFinite(seconds) ? seconds : 0;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function buildEpisodePartTimings(
  episode: Episode,
  segmentDurations: number[],
  cueDurations: CueTrackPathsDurations,
  cuesEnabled: boolean,
): EpisodePartTiming[] {
  const partLabels: Array<{ kind: EpisodePartTiming["kind"]; title: string; index?: number }> = [
    { kind: "intro", title: "Intro" },
    ...episode.segments.map((segment, index) => ({
      kind: "segment" as const,
      title: segment.title,
      index,
    })),
    { kind: "outro", title: "Outro" },
  ];

  let cursor = 0;
  return partLabels.map((part, index) => {
    if (index === 0) {
      const durationSeconds = segmentDurations[index] ?? 0;
      cursor += (cuesEnabled ? cueDurations.intro : 0) + durationSeconds;
      return { ...part, startTime: 0, durationSeconds };
    }

    if (cuesEnabled) cursor += cueDurations.transition;
    const durationSeconds = segmentDurations[index] ?? 0;
    const startTime = cursor;
    cursor += durationSeconds;
    return { ...part, startTime, durationSeconds };
  });
}

interface CueTrackPathsDurations {
  intro: number;
  transition: number;
  outro: number;
}
