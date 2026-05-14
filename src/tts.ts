import OpenAI from "openai";
import { execa } from "execa";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Episode, SpeakerId, SpeakerTurn } from "./types.js";
import { logJson, withRetry } from "./util.js";
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

export type SpeakerVoiceConfig = Record<SpeakerId, TTSVoice>;

export const TTS_DELIVERY_INSTRUCTIONS =
  "Deliver as an enthusiastic, sharp AI news podcast host: upbeat, engaged, and clear, " +
  "with natural momentum and emphasis on key takeaways. Stay precise and conversational; " +
  "do not shout, overact, or sound like an advertisement.";

export const TTS_DELIVERY_INSTRUCTIONS_BY_SPEAKER: Record<SpeakerId, string> = {
  anchor:
    `${TTS_DELIVERY_INSTRUCTIONS} Speaker persona: The Anchor is concise, skeptical, ` +
    "fact-forward, and keeps the story order straight.",
  analyst:
    `${TTS_DELIVERY_INSTRUCTIONS} Speaker persona: The Analyst is warmer, more playful, ` +
    "asks the practical so-what question, and uses memorable analogies without overacting.",
};

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

  const speakerVoices = resolveSpeakerVoices();
  const model = resolveTTSModel(process.env.TTS_MODEL);
  const timeoutMs = resolveTTSTimeoutMs(process.env.TTS_TIMEOUT_MS);

  const client = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 0 });

  const segmentDir = path.join(tmpdir(), `ai-briefing-${episode.date}-${process.pid}`);
  await mkdir(segmentDir, { recursive: true });

  const parts: { label: string; turns: SpeakerTurn[] }[] = [
    { label: "00-intro", turns: episode.intro },
    ...episode.segments.map((s, i) => ({
      label: `${pad2(i + 1)}-${slug(s.title)}`,
      turns: s.turns,
    })),
    { label: `${pad2(episode.segments.length + 1)}-outro`, turns: episode.outro },
  ];

  const segmentPaths: string[] = [];
  for (const part of parts) {
    const partStart = Date.now();
    const filePath = await synthesizePart(
      client,
      part,
      speakerVoices,
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
      turns: part.turns.length,
      chars: part.turns.reduce((sum, turn) => sum + turn.text.length, 0),
    });
  }

  logJson({
    phase: "tts",
    status: "ok",
    durationMs: Date.now() - started,
    segments: segmentPaths.length,
    voices: speakerVoices,
    model,
    timeoutMs,
    deliveryInstructions: supportsDeliveryInstructions(model) ? "enabled" : "unsupported",
  });

  return { segmentDir, segmentPaths };
}

async function synthesizePart(
  client: OpenAI,
  part: { label: string; turns: SpeakerTurn[] },
  speakerVoices: SpeakerVoiceConfig,
  model: TTSModel,
  segmentDir: string,
  timeoutMs: number,
): Promise<string> {
  if (part.turns.length === 0) throw new Error(`tts.${part.label}: no speaker turns provided`);

  const outputPath = path.join(segmentDir, `${part.label}.mp3`);
  const turnDir = path.join(segmentDir, `${part.label}-turns`);
  await mkdir(turnDir, { recursive: true });

  const turnPaths: string[] = [];
  for (const [index, turn] of part.turns.entries()) {
    const voice = resolveVoiceForTurn(turn, speakerVoices);
    const turnLabel = `${part.label}.turn-${pad2(index + 1)}.${turn.speaker}`;
    const turnPath = path.join(turnDir, `${pad2(index + 1)}-${turn.speaker}.mp3`);
    await withRetry(
      () =>
        writeSpeechFile(
          client,
          buildTurnSpeechRequest(turn, speakerVoices, model),
          turnPath,
          timeoutMs,
          turnLabel,
        ),
      { attempts: MAX_ATTEMPTS, label: `tts:${turnLabel}` },
    );
    turnPaths.push(turnPath);
    logJson({
      phase: "tts.turn",
      label: part.label,
      turn: index + 1,
      speaker: turn.speaker,
      voice,
      chars: turn.text.length,
      status: "ok",
    });
  }

  if (turnPaths.length === 1) {
    await copyFile(turnPaths[0]!, outputPath);
    return outputPath;
  }

  await concatSpeechFiles(turnPaths, outputPath, part.label);
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
  instructions = TTS_DELIVERY_INSTRUCTIONS,
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

export function buildTurnSpeechRequest(
  turn: SpeakerTurn,
  speakerVoices: SpeakerVoiceConfig,
  model: TTSModel = DEFAULT_MODEL,
): SpeechRequest {
  const voice = resolveVoiceForTurn(turn, speakerVoices);
  return buildSpeechRequest(
    turn.text,
    voice,
    model,
    TTS_DELIVERY_INSTRUCTIONS_BY_SPEAKER[turn.speaker],
  );
}

export function resolveSpeakerVoices(env: NodeJS.ProcessEnv = process.env): SpeakerVoiceConfig {
  const legacyVoice = resolveTTSVoice(env.TTS_VOICE, "onyx");
  return {
    anchor: resolveTTSVoice(env.TTS_ANCHOR_VOICE, legacyVoice),
    analyst: resolveTTSVoice(env.TTS_ANALYST_VOICE, "nova"),
  };
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

function resolveVoiceForTurn(turn: SpeakerTurn, speakerVoices: SpeakerVoiceConfig): TTSVoice {
  const voice = speakerVoices[turn.speaker];
  if (!voice) throw new Error(`No TTS voice configured for speaker: ${String(turn.speaker)}`);
  return voice;
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
