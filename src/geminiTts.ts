import { execa } from "execa";
import { rm, writeFile } from "node:fs/promises";
import {
  sanitizeSegmentDeliveryHint,
  type EpisodeSectionKind,
  type TTSDirectionConfig,
} from "./speakerProfiles.js";
import { logJson } from "./util.js";

/** Interactions API: unary Gemini 3.8 TTS returns WAV audio. */
export const GEMINI_TTS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

/** Lists the custom voices stored in the API key's Google project. */
export const GEMINI_VOICES_URL = "https://generativelanguage.googleapis.com/v1beta/voices";

export const DEFAULT_GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";

/**
 * Designed and replicated voices are stored in the Google project that created
 * them. The id is only resolvable with that project's API key.
 */
const DESIGNED_VOICE_ID = /^voice_[A-Za-z0-9_-]+$/;

export function isDesignedVoiceId(voice: string | undefined): boolean {
  return DESIGNED_VOICE_ID.test(voice?.trim() ?? "");
}

export interface GeminiSpeechInput {
  model: string;
  voice: string;
  text: string;
  /** Turn-level delivery. Kept out of `text` so Gemini 3.8 does not speak it. */
  style?: string;
}

/**
 * Situational delivery for one part. The designed voice already carries accent
 * and timbre; this adds the section pace and any per-segment hint.
 */
export function buildGeminiSpeechStyle(
  section: EpisodeSectionKind,
  direction: TTSDirectionConfig,
  segmentHint?: string,
): string {
  const hint = sanitizeSegmentDeliveryHint(segmentHint);
  return [direction.narrator, direction[section], hint].filter(Boolean).join(" ");
}

export function buildGeminiInteractionBody(speech: GeminiSpeechInput): Record<string, unknown> {
  const textPart: Record<string, unknown> = {
    type: "text",
    text: speech.text,
  };
  const style = speech.style?.trim();
  if (style) {
    textPart.annotations = [{ type: "speech_metadata", style }];
  }

  return {
    model: speech.model,
    input: [
      {
        type: "user_input",
        content: [textPart],
      },
    ],
    response_format: { type: "audio" },
    generation_config: {
      speech_config: [{ voice: speech.voice }],
    },
  };
}

export function extractGeminiAudioBase64(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw new Error("Gemini TTS returned an empty response");
  }

  const record = payload as Record<string, unknown>;
  const direct = nestedAudioData(record.output_audio);
  if (direct) return direct;

  const steps = Array.isArray(record.steps) ? record.steps : [];
  let last = "";
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const stepRecord = step as Record<string, unknown>;
    if (stepRecord.type !== "model_output") continue;
    const content = Array.isArray(stepRecord.content) ? stepRecord.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const partRecord = part as Record<string, unknown>;
      if (partRecord.type !== "audio") continue;
      const data = typeof partRecord.data === "string" ? partRecord.data : "";
      if (data) last = data;
    }
  }

  if (!last) throw new Error("Gemini TTS response did not include audio");
  return last;
}

export function formatGeminiTtsError(
  status: number,
  body: string,
  apiKey: string,
  label: string,
): string {
  let detail = body.replace(/\s+/g, " ").trim().slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string" && parsed.error.message.trim()) {
      detail = parsed.error.message.trim();
    }
  } catch {
    // Keep the truncated raw body.
  }
  if (apiKey) detail = detail.split(apiKey).join("[redacted]");
  return `Gemini TTS ${label} failed (HTTP ${status}): ${detail}`;
}

export function buildWavToMp3Args(wavPath: string, mp3Path: string): string[] {
  return ["-y", "-loglevel", "error", "-i", wavPath, "-c:a", "libmp3lame", "-b:a", "192k", mp3Path];
}

interface GeminiSpeechRequest {
  apiKey: string;
  speech: GeminiSpeechInput;
  timeoutMs: number;
  label: string;
  fetchImpl?: typeof fetch;
}

/** One Interactions API call; returns the WAV bytes. */
export async function requestGeminiSpeechWav(options: GeminiSpeechRequest): Promise<Buffer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    const response = await fetchImpl(GEMINI_TTS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": options.apiKey,
      },
      body: JSON.stringify(buildGeminiInteractionBody(options.speech)),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new GeminiTtsHttpError(
        response.status,
        formatGeminiTtsError(response.status, body, options.apiKey, options.label),
      );
    }

    const payload: unknown = await response.json();
    const wav = Buffer.from(extractGeminiAudioBase64(payload), "base64");
    if (wav.length < 44) {
      throw new Error(`Gemini TTS ${options.label}: audio payload was empty`);
    }
    return wav;
  } catch (err) {
    if (timedOut || (err instanceof Error && err.name === "AbortError")) {
      throw new Error(`Timeout after ${options.timeoutMs}ms: tts.${options.label}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export class GeminiTtsHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GeminiTtsHttpError";
  }
}

export async function writeGeminiSpeechMp3(
  options: GeminiSpeechRequest & { outputPath: string },
): Promise<void> {
  const wavPath = `${options.outputPath}.wav`;
  try {
    const wav = await requestGeminiSpeechWav(options);
    await writeFile(wavPath, wav);
    await execa("ffmpeg", buildWavToMp3Args(wavPath, options.outputPath));
  } finally {
    await rm(wavPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Speak one word with the configured voice before any paid LLM stage. A
 * designed voice that the key's Google project cannot see returns 404 on
 * every request, so finding out after curation and scripting wastes ~4
 * minutes of model calls per run. Throws an actionable error on 403/404;
 * other failures (timeouts, 5xx) are left for the real TTS stage to retry.
 */
export async function assertGeminiVoiceReachable(options: {
  apiKey: string;
  model: string;
  voice: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  try {
    await requestGeminiSpeechWav({
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
      label: "voice-check",
      fetchImpl: options.fetchImpl,
      speech: { model: options.model, voice: options.voice, text: "Check." },
    });
  } catch (err) {
    if (err instanceof GeminiTtsHttpError && (err.status === 403 || err.status === 404)) {
      if (!isDesignedVoiceId(options.voice)) {
        throw new Error(`${err.message} Check that ${options.voice} is a valid Gemini voice for ${options.model}.`);
      }
      // Name what the key can see, so the fix is readable from the run log.
      const visible = await listGeminiCustomVoices(options);
      throw new Error(
        `${err.message} GEMINI_API_KEY must belong to the Google project that created ${options.voice}, ` +
          "or pick a different voice on the tune page (config/show.json tts.voice). " +
          "Stored custom voices expire 1 year after their last use. " +
          describeVisibleVoices(visible),
      );
    }
    logJson({
      phase: "tts.voice_check",
      status: "warn",
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const expireTime = isDesignedVoiceId(options.voice)
    ? (await listGeminiCustomVoices(options))?.find((v) => v.id === options.voice)?.expireTime
    : undefined;
  logJson({
    phase: "tts.voice_check",
    status: "ok",
    model: options.model,
    ...(expireTime ? { voiceExpiresAt: expireTime } : {}),
  });
}

export interface GeminiCustomVoice {
  id: string;
  displayName?: string;
  expireTime?: string;
}

/**
 * Custom (`voice_…`) voices visible to this key, or null when the list call
 * fails. Diagnostic only: never throws, and drops Google's prebuilt voices.
 */
export async function listGeminiCustomVoices(options: {
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<GeminiCustomVoice[] | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(GEMINI_VOICES_URL, {
      headers: { "x-goog-api-key": options.apiKey },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { voices?: unknown };
    if (!Array.isArray(payload.voices)) return [];
    const voices: GeminiCustomVoice[] = [];
    for (const raw of payload.voices) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.replace(/^voices\//, "") : "";
      if (!isDesignedVoiceId(id)) continue;
      const displayName = stringField(record, "displayName", "display_name");
      const expireTime = stringField(record, "expireTime", "expire_time");
      voices.push({ id, ...(displayName ? { displayName } : {}), ...(expireTime ? { expireTime } : {}) });
    }
    return voices;
  } catch {
    return null;
  }
}

export function describeVisibleVoices(voices: readonly GeminiCustomVoice[] | null): string {
  if (voices === null) return "Could not list this key's custom voices.";
  if (voices.length === 0) return "This key's project has no stored custom voices.";
  const list = voices
    .slice(0, 10)
    .map((v) => {
      const details = [v.displayName ? `"${v.displayName.slice(0, 60)}"` : "", v.expireTime ? `expires ${v.expireTime}` : ""]
        .filter(Boolean)
        .join(", ");
      return details ? `${v.id} (${details})` : v.id;
    })
    .join("; ");
  return `This key's project can see: ${list}.`;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function nestedAudioData(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const data = (value as { data?: unknown }).data;
  return typeof data === "string" && data.length > 0 ? data : "";
}
