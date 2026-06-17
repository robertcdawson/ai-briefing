import OpenAI from "openai";
import { execa } from "execa";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Episode, NarrationChunk } from "./types.js";
import { logJson, withRetry } from "./util.js";
import { stripInlineAudioTags } from "./audioTags.js";
import { applyPronunciations } from "./pronunciations.js";
import {
  buildChunkSpeechInstructions,
  DEFAULT_GLOBAL_TTS_STYLE,
  NARRATOR_PROFILE,
  resolveTTSDirection,
  type EpisodeSectionKind,
  type TTSDirectionConfig,
} from "./speakerProfiles.js";
import {
  DEFAULT_OPENAI_TTS_MODEL,
  OPENAI_TTS_MODELS,
  resolveTTSProviderConfig,
  supportsOpenAIDeliveryInstructions,
  type TTSProviderConfig,
} from "./ttsProvider.js";
import { resolveTTSVoice, type TTSVoice } from "./voices.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_ATTEMPTS = 3;
/** Breathing room inserted between chunks when a part is synthesized chunk-by-chunk. */
export const CHUNK_GAP_SECONDS = 0.4;

export type TTSModel = (typeof OPENAI_TTS_MODELS)[number];
export type { TTSVoice };
export { OPENAI_TTS_MODELS, resolveTTSProviderConfig } from "./ttsProvider.js";
export type { TTSProviderConfig, TTSProviderId } from "./ttsProvider.js";

export interface TTSResult {
  segmentDir: string;
  segmentPaths: string[];
}

export interface SpeechRequest {
  model: string;
  voice: string;
  input: string;
  response_format: "mp3";
  instructions?: string;
}

export async function synthesize(episode: Episode): Promise<TTSResult> {
  const started = Date.now();
  const config = resolveTTSProviderConfig();
  const apiKey = process.env[config.apiKeyEnvVar];
  if (!apiKey) throw new Error(`${config.apiKeyEnvVar} is not set`);

  const direction = resolveTTSDirection();
  const timeoutMs = resolveTTSTimeoutMs(process.env.TTS_TIMEOUT_MS);

  const client = new OpenAI({
    apiKey,
    baseURL: config.baseURL,
    timeout: timeoutMs,
    maxRetries: 0,
  });

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
    const filePath = await synthesizePart(client, part, config, direction, segmentDir, timeoutMs);
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
    provider: config.provider,
    voice: config.voice,
    direction,
    model: config.model,
    timeoutMs,
    deliveryInstructions: config.supportsDeliveryInstructions ? "enabled" : "unsupported",
    inlineAudioTags: config.supportsInlineAudioTags ? "enabled" : "stripped",
  });

  return { segmentDir, segmentPaths };
}

async function synthesizePart(
  client: OpenAI,
  part: { label: string; section: EpisodeSectionKind; chunks: NarrationChunk[] },
  config: TTSProviderConfig,
  direction: TTSDirectionConfig,
  segmentDir: string,
  timeoutMs: number,
): Promise<string> {
  if (part.chunks.length === 0) throw new Error(`tts.${part.label}: no narration chunks provided`);

  const outputPath = path.join(segmentDir, `${part.label}.mp3`);

  // Prefer one request per part: continuous prosody across the whole monologue
  // beats per-chunk synthesis, which resets intonation at every boundary.
  const partRequest = buildPartSpeechRequest(part.chunks, config, part.section, direction);
  if (partRequest.input.length <= config.maxRequestChars) {
    await withRetry(
      () => writeSpeechFile(client, partRequest, outputPath, timeoutMs, part.label),
      { attempts: MAX_ATTEMPTS, label: `tts:${part.label}` },
    );
    return outputPath;
  }

  // Fallback for parts that exceed the provider's input limit: synthesize each
  // chunk separately and rejoin them with a short breathing gap.
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
          buildPartSpeechRequest([chunk], config, part.section, direction),
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
      voice: config.voice,
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
  voice: string,
  model: string = DEFAULT_OPENAI_TTS_MODEL,
  instructions = DEFAULT_GLOBAL_TTS_STYLE,
): SpeechRequest {
  const request: SpeechRequest = {
    model,
    voice,
    input,
    response_format: "mp3",
  };

  if (supportsOpenAIDeliveryInstructions(model)) {
    request.instructions = instructions;
  }

  return request;
}

export function buildChunkSpeechRequest(
  text: NarrationChunk,
  voice: string,
  model: string = DEFAULT_OPENAI_TTS_MODEL,
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

/**
 * Build one speech request for a whole part (or a single chunk on fallback):
 * chunks are joined into one continuous monologue, inline delivery tags are
 * stripped for models that would read them aloud, and the OpenAI-style
 * `instructions` field is sent only to models that honor it.
 */
export function buildPartSpeechRequest(
  chunks: readonly NarrationChunk[],
  config: TTSProviderConfig,
  section: EpisodeSectionKind = "story",
  direction: TTSDirectionConfig = resolveTTSDirection(),
): SpeechRequest {
  const joined = chunks
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .join("\n\n");
  // M9: respell hard-to-pronounce names for the synthesizer only. This is the
  // audio boundary — the canonical script/transcript (written by publish.ts)
  // keeps the correct spelling.
  const spoken = config.supportsInlineAudioTags ? joined : stripInlineAudioTags(joined);
  const input = applyPronunciations(spoken);

  const request: SpeechRequest = {
    model: config.model,
    voice: config.voice,
    input,
    response_format: "mp3",
  };

  if (config.supportsDeliveryInstructions) {
    request.instructions = buildChunkSpeechInstructions(section, direction);
  }

  return request;
}

export function resolveNarratorVoice(env: NodeJS.ProcessEnv = process.env): TTSVoice {
  return resolveTTSVoice(env.TTS_VOICE, NARRATOR_PROFILE.defaultVoice);
}

export function resolveTTSTimeoutMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  const rounded = Math.round(parsed);
  if (rounded < MIN_TIMEOUT_MS || rounded > MAX_TIMEOUT_MS) return DEFAULT_TIMEOUT_MS;
  return rounded;
}

async function concatSpeechFiles(
  inputs: string[],
  outputPath: string,
  label: string,
): Promise<void> {
  const args = buildConcatSpeechArgs(inputs, outputPath);
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

/**
 * Concatenate chunk audio with a short silence appended to every chunk except
 * the last, so chunk-by-chunk fallback synthesis still breathes naturally.
 */
export function buildConcatSpeechArgs(
  inputs: readonly string[],
  outputPath: string,
  gapSeconds: number = CHUNK_GAP_SECONDS,
): string[] {
  const padFilters = inputs
    .slice(0, -1)
    .map((_, index) => `[${index}:a:0]apad=pad_dur=${gapSeconds}[p${index}];`)
    .join("");
  const concatInputs = inputs
    .map((_, index) => (index < inputs.length - 1 ? `[p${index}]` : `[${index}:a:0]`))
    .join("");
  return [
    "-y",
    "-loglevel", "error",
    ...inputs.flatMap((input) => ["-i", input]),
    "-filter_complex", `${padFilters}${concatInputs}concat=n=${inputs.length}:v=0:a=1[a]`,
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
