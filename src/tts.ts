import OpenAI from "openai";
import { execa } from "execa";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Episode, NarrationChunk } from "./types.js";
import { logJson, withRetry } from "./util.js";
import {
  buildChunkSpeechInstructions,
  DEFAULT_GLOBAL_TTS_STYLE,
  NARRATOR_PROFILE,
  resolveTTSDirection,
  type EpisodeSectionKind,
  type TTSDirectionConfig,
} from "./speakerProfiles.js";
import { resolveTTSVoice, type TTSVoice } from "./voices.js";

const DEFAULT_MODEL = "gpt-4o-mini-tts";
const DEFAULT_TIMEOUT_MS = 180_000;
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_ATTEMPTS = 3;
const TTS_MODELS = [
  "tts-1",
  "tts-1-hd",
  "gpt-4o-mini-tts",
  "gpt-4o-mini-tts-2025-12-15",
] as const;
export type TTSModel = (typeof TTS_MODELS)[number];
export type { TTSVoice };

export interface TTSResult {
  segmentDir: string;
  segmentPaths: string[];
}

export interface SpeechRequest {
  model: TTSModel;
  voice: TTSVoice;
  input: string;
  response_format: "mp3";
  instructions?: string;
}

export async function synthesize(episode: Episode): Promise<TTSResult> {
  const started = Date.now();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const voice = resolveNarratorVoice();
  const direction = resolveTTSDirection();
  const model = resolveTTSModel(process.env.TTS_MODEL);
  const timeoutMs = resolveTTSTimeoutMs(process.env.TTS_TIMEOUT_MS);

  const client = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 0 });

  const segmentDir = path.join(tmpdir(), `ai-briefing-${episode.date}-${process.pid}`);
  await mkdir(segmentDir, { recursive: true });

  const parts: { label: string; section: EpisodeSectionKind; chunks: NarrationChunk[] }[] = [
    { label: "00-intro", section: "intro", chunks: episode.intro },
    ...episode.segments.map((s, i) => ({
      label: `${pad2(i + 1)}-${slug(s.title)}`,
      section: "story" as const,
      chunks: s.chunks,
    })),
    { label: `${pad2(episode.segments.length + 1)}-outro`, section: "outro", chunks: episode.outro },
  ];

  const segmentPaths: string[] = [];
  for (const part of parts) {
    const partStart = Date.now();
    const filePath = await synthesizePart(
      client,
      part,
      voice,
      direction,
      model,
      segmentDir,
      timeoutMs,
    );
    segmentPaths.push(filePath);
    logJson({
      phase: "tts",
      label: part.label,
      status: "ok",
      durationMs: Date.now() - partStart,
      section: part.section,
      chunks: part.chunks.length,
      chars: part.chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    });
  }

  logJson({
    phase: "tts",
    status: "ok",
    durationMs: Date.now() - started,
    segments: segmentPaths.length,
    voice,
    direction,
    model,
    timeoutMs,
    deliveryInstructions: supportsDeliveryInstructions(model) ? "enabled" : "unsupported",
  });

  return { segmentDir, segmentPaths };
}

async function synthesizePart(
  client: OpenAI,
  part: { label: string; section: EpisodeSectionKind; chunks: NarrationChunk[] },
  voice: TTSVoice,
  direction: TTSDirectionConfig,
  model: TTSModel,
  segmentDir: string,
  timeoutMs: number,
): Promise<string> {
  if (part.chunks.length === 0) throw new Error(`tts.${part.label}: no narration chunks provided`);

  const outputPath = path.join(segmentDir, `${part.label}.mp3`);
  const chunkDir = path.join(segmentDir, `${part.label}-chunks`);
  await mkdir(chunkDir, { recursive: true });

  const chunkPaths: string[] = [];
  for (const [index, chunk] of part.chunks.entries()) {
    const chunkLabel = `${part.label}.chunk-${pad2(index + 1)}`;
    const chunkPath = path.join(chunkDir, `${pad2(index + 1)}.mp3`);
    await withRetry(
      () =>
        writeSpeechFile(
          client,
          buildChunkSpeechRequest(chunk, voice, model, part.section, direction),
          chunkPath,
          timeoutMs,
          chunkLabel,
        ),
      { attempts: MAX_ATTEMPTS, label: `tts:${chunkLabel}` },
    );
    chunkPaths.push(chunkPath);
    logJson({
      phase: "tts.chunk",
      label: part.label,
      chunk: index + 1,
      section: part.section,
      voice,
      chars: chunk.length,
      status: "ok",
    });
  }

  if (chunkPaths.length === 1) {
    await copyFile(chunkPaths[0]!, outputPath);
    return outputPath;
  }

  await concatSpeechFiles(chunkPaths, outputPath, part.label);
  return outputPath;
}

async function writeSpeechFile(
  client: OpenAI,
  request: SpeechRequest,
  filePath: string,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await client.audio.speech.create(
      request,
      { signal: controller.signal, timeout: timeoutMs },
    );
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(filePath, buffer);
  } catch (err) {
    if (timedOut) {
      throw new Error(`Timeout after ${timeoutMs}ms: tts.${label}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export function buildSpeechRequest(
  input: string,
  voice: TTSVoice,
  model: TTSModel = DEFAULT_MODEL,
  instructions = DEFAULT_GLOBAL_TTS_STYLE,
): SpeechRequest {
  const request: SpeechRequest = {
    model,
    voice,
    input,
    response_format: "mp3",
  };

  if (supportsDeliveryInstructions(model)) {
    request.instructions = instructions;
  }

  return request;
}

export function buildChunkSpeechRequest(
  text: NarrationChunk,
  voice: TTSVoice,
  model: TTSModel = DEFAULT_MODEL,
  section: EpisodeSectionKind = "story",
  direction: TTSDirectionConfig = resolveTTSDirection(),
): SpeechRequest {
  return buildSpeechRequest(
    text,
    voice,
    model,
    buildChunkSpeechInstructions(section, direction),
  );
}

export function resolveNarratorVoice(env: NodeJS.ProcessEnv = process.env): TTSVoice {
  return resolveTTSVoice(env.TTS_VOICE, NARRATOR_PROFILE.defaultVoice);
}

function resolveTTSModel(requestedModel: string | undefined): TTSModel {
  if (requestedModel && TTS_MODELS.includes(requestedModel as TTSModel)) {
    return requestedModel as TTSModel;
  }
  return DEFAULT_MODEL;
}

export function resolveTTSTimeoutMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  const rounded = Math.round(parsed);
  if (rounded < MIN_TIMEOUT_MS || rounded > MAX_TIMEOUT_MS) return DEFAULT_TIMEOUT_MS;
  return rounded;
}

function supportsDeliveryInstructions(model: TTSModel): boolean {
  return model !== "tts-1" && model !== "tts-1-hd";
}

async function concatSpeechFiles(
  inputs: string[],
  outputPath: string,
  label: string,
): Promise<void> {
  const filterInputs = inputs.map((_, index) => `[${index}:a:0]`).join("");
  const args = buildConcatSpeechArgs(inputs, outputPath, filterInputs);
  await withRetry(
    () =>
      execa(
        "ffmpeg",
        args,
        {
          stdio: ["ignore", "ignore", "pipe"],
          timeout: 60_000,
          forceKillAfterDelay: 1_000,
        },
      ).then(() => undefined),
    { attempts: MAX_ATTEMPTS, label: `ffmpeg.tts_concat.${label}` },
  );
}

export function buildConcatSpeechArgs(
  inputs: readonly string[],
  outputPath: string,
  filterInputs = inputs.map((_, index) => `[${index}:a:0]`).join(""),
): string[] {
  return [
    "-y",
    "-loglevel", "error",
    ...inputs.flatMap((input) => ["-i", input]),
    "-filter_complex", `${filterInputs}concat=n=${inputs.length}:v=0:a=1[a]`,
    "-map", "[a]",
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    outputPath,
  ];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "segment";
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

export {
  DEFAULT_GLOBAL_TTS_STYLE,
  resolveTTSDirection,
} from "./speakerProfiles.js";
