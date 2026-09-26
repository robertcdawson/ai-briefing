import { execa } from "execa";
import { rm, writeFile } from "node:fs/promises";
import {
  sanitizeSegmentDeliveryHint,
  type EpisodeSectionKind,
  type TTSDirectionConfig,
} from "./speakerProfiles.js";

/** Interactions API: unary Gemini 3.8 TTS returns WAV audio. */
export const GEMINI_TTS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

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

export async function writeGeminiSpeechMp3(options: {
  apiKey: string;
  speech: GeminiSpeechInput;
  outputPath: string;
  timeoutMs: number;
  label: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  const wavPath = `${options.outputPath}.wav`;
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
      throw new Error(formatGeminiTtsError(response.status, body, options.apiKey, options.label));
    }

    const payload: unknown = await response.json();
    const wav = Buffer.from(extractGeminiAudioBase64(payload), "base64");
    if (wav.length < 44) {
      throw new Error(`Gemini TTS ${options.label}: audio payload was empty`);
    }

    await writeFile(wavPath, wav);
    await execa("ffmpeg", buildWavToMp3Args(wavPath, options.outputPath));
  } catch (err) {
    if (timedOut || (err instanceof Error && err.name === "AbortError")) {
      throw new Error(`Timeout after ${options.timeoutMs}ms: tts.${options.label}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    await rm(wavPath, { force: true }).catch(() => undefined);
  }
}

function nestedAudioData(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const data = (value as { data?: unknown }).data;
  return typeof data === "string" && data.length > 0 ? data : "";
}
