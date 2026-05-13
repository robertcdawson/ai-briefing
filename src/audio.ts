import { execa } from "execa";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Episode, EpisodePartTiming } from "./types.js";
import { logJson, withRetry } from "./util.js";

const TIMEOUT_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const TARGET_SAMPLE_RATE = "44100";
const TARGET_CHANNELS = "2";

interface CueTrackPaths {
  intro: string;
  transition: string;
  outro: string;
}

type AudioCueStyle = "tone" | "chime" | "tick";

interface CueToneSpec {
  frequency: number;
  durationSeconds: number;
  volume: number;
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
  const cueStyle = resolveAudioCueStyle();
  const cueTracks = cuesEnabled ? await synthesizeCueTracks(workDir, cueStyle) : null;
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
  const partTimings = buildEpisodePartTimings(episode, segmentDurations, cueDurations, cuesEnabled);
  const estimatedDurationSeconds = estimateProgramDuration(segmentDurations, cueDurations, cuesEnabled);
  const chapterMetadataPath = path.join(workDir, "chapters.ffmetadata");
  await writeFile(chapterMetadataPath, buildFfmpegChapterMetadata(partTimings, estimatedDurationSeconds));

  const finalPath = path.join(workDir, `${episode.date}.mp3`);
  await runFfmpeg(
    [
      "-y",
      "-loglevel", "error",
      "-i", concatPath,
      "-f", "ffmetadata",
      "-i", chapterMetadataPath,
      "-map", "0:a:0",
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
      "-map_metadata", "1",
      "-map_chapters", "1",
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
    cuesEnabled,
    cueStyle: cuesEnabled ? cueStyle : "off",
    chaptersEmbedded: partTimings.length,
  });

  return { finalPath, byteLength: stats.size, durationSeconds, partTimings };
}

export function resolveAudioCuesEnabled(value = process.env.AUDIO_CUES_ENABLED): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

export function resolveAudioCueStyle(value = process.env.AUDIO_CUE_STYLE): AudioCueStyle {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "chime" || normalized === "tick") return normalized;
  return "tone";
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
      execa("ffmpeg", args, {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: TIMEOUT_MS,
        forceKillAfterDelay: 1_000,
      }).then(() => undefined),
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

async function synthesizeCueTracks(workDir: string, style: AudioCueStyle): Promise<CueTrackPaths> {
  const intro = path.join(workDir, "cue-intro.wav");
  const transition = path.join(workDir, "cue-transition.wav");
  const outro = path.join(workDir, "cue-outro.wav");
  const spec = getCueToneSpec(style);

  await Promise.all([
    synthesizeCueTone(intro, spec.intro, "intro"),
    synthesizeCueTone(transition, spec.transition, "transition"),
    synthesizeCueTone(outro, spec.outro, "outro"),
  ]);

  return { intro, transition, outro };
}

async function synthesizeCueTone(
  outputPath: string,
  spec: CueToneSpec,
  label: string,
): Promise<void> {
  const { durationSeconds, frequency, volume } = spec;
  const fadeOutStart = Math.max(0, durationSeconds - 0.04);
  await runFfmpeg(
    [
      "-y",
      "-loglevel", "error",
      "-f", "lavfi",
      "-i", `sine=frequency=${frequency}:sample_rate=${TARGET_SAMPLE_RATE}:duration=${durationSeconds}`,
      "-af",
      `volume=${volume.toFixed(2)},afade=t=in:st=0:d=0.015,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.04`,
      "-c:a", "pcm_s16le",
      "-ar", TARGET_SAMPLE_RATE,
      "-ac", TARGET_CHANNELS,
      outputPath,
    ],
    `cue.${label}`,
  );
}

function getCueToneSpec(style: AudioCueStyle): Record<keyof CueTrackPaths, CueToneSpec> {
  switch (style) {
    case "chime":
      return {
        intro: { frequency: 1318.51, durationSeconds: 0.30, volume: 0.08 },
        transition: { frequency: 987.77, durationSeconds: 0.22, volume: 0.07 },
        outro: { frequency: 783.99, durationSeconds: 0.36, volume: 0.07 },
      };
    case "tick":
      return {
        intro: { frequency: 1760, durationSeconds: 0.08, volume: 0.08 },
        transition: { frequency: 1320, durationSeconds: 0.06, volume: 0.07 },
        outro: { frequency: 880, durationSeconds: 0.10, volume: 0.07 },
      };
    case "tone":
      return {
        intro: { frequency: 1046.5, durationSeconds: 0.22, volume: 0.10 },
        transition: { frequency: 880, durationSeconds: 0.16, volume: 0.10 },
        outro: { frequency: 659.25, durationSeconds: 0.28, volume: 0.10 },
      };
  }
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

function estimateProgramDuration(
  segmentDurations: number[],
  cueDurations: CueTrackPathsDurations,
  cuesEnabled: boolean,
): number {
  const narrationSeconds = segmentDurations.reduce((sum, duration) => sum + duration, 0);
  if (!cuesEnabled) return narrationSeconds;
  const transitionCount = Math.max(0, segmentDurations.length - 1);
  return narrationSeconds + cueDurations.intro + cueDurations.outro + (cueDurations.transition * transitionCount);
}

export function buildFfmpegChapterMetadata(
  partTimings: EpisodePartTiming[],
  durationSeconds: number,
): string {
  const lines = [";FFMETADATA1"];
  for (const [index, part] of partTimings.entries()) {
    const startMs = secondsToMilliseconds(part.startTime);
    const next = partTimings[index + 1];
    const fallbackEnd = index === partTimings.length - 1
      ? durationSeconds
      : next?.startTime ?? part.startTime + part.durationSeconds;
    const endMs = Math.max(startMs, secondsToMilliseconds(fallbackEnd));
    lines.push(
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      `START=${startMs}`,
      `END=${endMs}`,
      `title=${escapeFfmpegMetadataValue(formatChapterTitle(part))}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatChapterTitle(part: EpisodePartTiming): string {
  if (part.kind === "intro") return "Intro";
  if (part.kind === "outro") return "Outro";
  const stripped = part.title.replace(/^[^:]{1,32}:\s+/, "").trim() || part.title.trim();
  return truncateForPodcastApp(stripped);
}

function truncateForPodcastApp(title: string): string {
  if (title.length <= 45) return title;
  const truncated = title.slice(0, 42).replace(/\s+\S*$/, "").trim();
  return `${truncated || title.slice(0, 42)}...`;
}

function secondsToMilliseconds(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1000));
}

function escapeFfmpegMetadataValue(value: string): string {
  return value.replace(/[\\=;#\n\r]/g, (char) => {
    switch (char) {
      case "\n":
      case "\r":
        return " ";
      default:
        return `\\${char}`;
    }
  });
}

interface CueTrackPathsDurations {
  intro: number;
  transition: number;
  outro: number;
}
