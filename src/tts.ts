import OpenAI from "openai";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Episode } from "./types.js";
import { logJson, withRetry } from "./util.js";

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

export type TTSVoice =
  | "alloy" | "ash" | "ballad" | "cedar" | "coral" | "echo" | "fable"
  | "marin" | "nova" | "onyx" | "sage" | "shimmer" | "verse";
const VALID_VOICES: TTSVoice[] = [
  "alloy", "ash", "ballad", "cedar", "coral", "echo", "fable",
  "marin", "nova", "onyx", "sage", "shimmer", "verse",
];

export const TTS_DELIVERY_INSTRUCTIONS =
  "Deliver as an enthusiastic, sharp AI news podcast host: upbeat, engaged, and clear, " +
  "with natural momentum and emphasis on key takeaways. Stay precise and conversational; " +
  "do not shout, overact, or sound like an advertisement.";

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

  const requestedVoice = (process.env.TTS_VOICE ?? "onyx") as TTSVoice;
  const voice: TTSVoice = VALID_VOICES.includes(requestedVoice) ? requestedVoice : "onyx";
  const model = resolveTTSModel(process.env.TTS_MODEL);
  const timeoutMs = resolveTTSTimeoutMs(process.env.TTS_TIMEOUT_MS);

  const client = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 0 });

  const segmentDir = path.join(tmpdir(), `ai-briefing-${episode.date}-${process.pid}`);
  await mkdir(segmentDir, { recursive: true });

  const parts: { label: string; text: string }[] = [
    { label: "00-intro", text: episode.intro },
    ...episode.segments.map((s, i) => ({
      label: `${pad2(i + 1)}-${slug(s.title)}`,
      text: s.script,
    })),
    { label: `${pad2(episode.segments.length + 1)}-outro`, text: episode.outro },
  ];

  const segmentPaths: string[] = [];
  for (const part of parts) {
    const partStart = Date.now();
    const filePath = path.join(segmentDir, `${part.label}.mp3`);
    await withRetry(
      () => writeSpeechFile(client, buildSpeechRequest(part.text, voice, model), filePath, timeoutMs, part.label),
      { attempts: MAX_ATTEMPTS, label: `tts:${part.label}` },
    );
    segmentPaths.push(filePath);
    logJson({
      phase: "tts",
      label: part.label,
      status: "ok",
      durationMs: Date.now() - partStart,
      chars: part.text.length,
    });
  }

  logJson({
    phase: "tts",
    status: "ok",
    durationMs: Date.now() - started,
    segments: segmentPaths.length,
    voice,
    model,
    timeoutMs,
    deliveryInstructions: supportsDeliveryInstructions(model) ? "enabled" : "unsupported",
  });

  return { segmentDir, segmentPaths };
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
): SpeechRequest {
  const request: SpeechRequest = {
    model,
    voice,
    input,
    response_format: "mp3",
  };

  if (supportsDeliveryInstructions(model)) {
    request.instructions = TTS_DELIVERY_INSTRUCTIONS;
  }

  return request;
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

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "segment";
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
