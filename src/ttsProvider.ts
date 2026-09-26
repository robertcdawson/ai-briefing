import { supportsInlineAudioTags } from "./audioTags.js";
import { DEFAULT_GEMINI_TTS_MODEL, isDesignedVoiceId } from "./geminiTts.js";
import { NARRATOR_PROFILE } from "./speakerProfiles.js";
import { resolveTTSVoice } from "./voices.js";

export type TTSProviderId = "openai" | "openrouter" | "gemini";

export const OPENROUTER_TTS_BASE_URL = "https://openrouter.ai/api/v1";

export const OPENAI_TTS_MODELS = [
  "tts-1",
  "tts-1-hd",
  "gpt-4o-mini-tts",
  "gpt-4o-mini-tts-2025-12-15",
] as const;
export type OpenAITTSModel = (typeof OPENAI_TTS_MODELS)[number];

export const DEFAULT_OPENAI_TTS_MODEL: OpenAITTSModel = "gpt-4o-mini-tts";
export const DEFAULT_OPENROUTER_TTS_MODEL = "google/gemini-3.1-flash-tts-preview";
/** Gemini TTS prebuilt voice with an informative, host-like read. */
export const DEFAULT_OPENROUTER_TTS_VOICE = "Charon";
export { DEFAULT_GEMINI_TTS_MODEL };

// OpenAI's speech endpoint caps input at 4096 characters. Gemini TTS accepts
// much longer prompts (8k-token context); stay comfortably below it.
const OPENAI_MAX_REQUEST_CHARS = 4096;
const OPENROUTER_MAX_REQUEST_CHARS = 8000;

export interface TTSProviderConfig {
  provider: TTSProviderId;
  model: string;
  voice: string;
  /** undefined means the OpenAI SDK default base URL. */
  baseURL?: string;
  apiKeyEnvVar: "OPENAI_API_KEY" | "OPENROUTER_API_KEY" | "GEMINI_API_KEY";
  /** Whether the model honors the OpenAI `instructions` delivery field. */
  supportsDeliveryInstructions: boolean;
  /** Whether the model interprets bracketed inline delivery tags. */
  supportsInlineAudioTags: boolean;
  /** Largest narration text sent in a single speech request. */
  maxRequestChars: number;
}

export function resolveTTSProvider(
  env: NodeJS.ProcessEnv = process.env,
  fileVoice?: string,
): TTSProviderId {
  const requested = env.TTS_PROVIDER?.trim().toLowerCase();
  if (requested === "openrouter" || requested === "gemini" || requested === "openai") {
    return requested;
  }
  // A designed voice id only exists in the caller's Google project, so it
  // selects the Gemini API when no provider was set explicitly.
  if (isDesignedVoiceId(firstNonEmpty(env.TTS_VOICE, fileVoice))) return "gemini";
  return "openai";
}

export function resolveTTSProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
  fileVoice?: string,
): TTSProviderConfig {
  const provider = resolveTTSProvider(env, fileVoice);

  if (provider === "gemini") {
    return {
      provider,
      model: resolveGeminiTtsModel(env.TTS_MODEL),
      voice: firstNonEmpty(env.TTS_VOICE, fileVoice) || DEFAULT_OPENROUTER_TTS_VOICE,
      apiKeyEnvVar: "GEMINI_API_KEY",
      // Accent and pace go in speech_metadata.style, not the OpenAI instructions field.
      supportsDeliveryInstructions: false,
      // Gemini 3.8 reads the transcript verbatim, including square-bracket tags.
      supportsInlineAudioTags: false,
      maxRequestChars: OPENROUTER_MAX_REQUEST_CHARS,
    };
  }

  if (provider === "openrouter") {
    const model = env.TTS_MODEL?.trim() || DEFAULT_OPENROUTER_TTS_MODEL;
    return {
      provider,
      model,
      // OpenRouter voices are model-specific strings (e.g. Gemini's "Charon"),
      // so accept any non-empty override rather than the OpenAI voice list.
      // A non-empty TTS_VOICE env var wins over the show-config voice.
      voice: firstNonEmpty(env.TTS_VOICE, fileVoice) || DEFAULT_OPENROUTER_TTS_VOICE,
      baseURL: OPENROUTER_TTS_BASE_URL,
      apiKeyEnvVar: "OPENROUTER_API_KEY",
      supportsDeliveryInstructions: false,
      supportsInlineAudioTags: supportsInlineAudioTags(model),
      maxRequestChars: OPENROUTER_MAX_REQUEST_CHARS,
    };
  }

  const model = resolveOpenAITTSModel(env.TTS_MODEL);
  return {
    provider,
    model,
    voice: resolveOpenAIVoice(env.TTS_VOICE, fileVoice),
    apiKeyEnvVar: "OPENAI_API_KEY",
    supportsDeliveryInstructions: supportsOpenAIDeliveryInstructions(model),
    supportsInlineAudioTags: false,
    maxRequestChars: OPENAI_MAX_REQUEST_CHARS,
  };
}

/**
 * A non-empty TTS_VOICE env var wins, including an invalid one (that falls
 * back to the narrator default rather than the file). A blank env var —
 * what GitHub Actions injects when the variable is unset — falls through
 * to the show-config voice, then the narrator default.
 */
function resolveOpenAIVoice(envVoice: string | undefined, fileVoice: string | undefined): string {
  const fromEnv = envVoice?.trim();
  if (fromEnv) return resolveTTSVoice(fromEnv, NARRATOR_PROFILE.defaultVoice);
  return resolveTTSVoice(fileVoice?.trim(), NARRATOR_PROFILE.defaultVoice);
}

function firstNonEmpty(envVoice: string | undefined, fileVoice: string | undefined): string {
  return envVoice?.trim() || fileVoice?.trim() || "";
}

export function resolveOpenAITTSModel(requestedModel: string | undefined): OpenAITTSModel {
  if (requestedModel && OPENAI_TTS_MODELS.includes(requestedModel as OpenAITTSModel)) {
    return requestedModel as OpenAITTSModel;
  }
  return DEFAULT_OPENAI_TTS_MODEL;
}

export function supportsOpenAIDeliveryInstructions(model: string): boolean {
  return model !== "tts-1" && model !== "tts-1-hd";
}

/**
 * A leftover OpenAI model id in TTS_MODEL must not be sent to Gemini. An
 * explicit non-OpenAI id (including Flash-Lite) is honored.
 */
function resolveGeminiTtsModel(requestedModel: string | undefined): string {
  const model = requestedModel?.trim();
  if (!model || OPENAI_TTS_MODELS.includes(model as OpenAITTSModel)) {
    return DEFAULT_GEMINI_TTS_MODEL;
  }
  return model;
}
