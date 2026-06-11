import { supportsInlineAudioTags } from "./audioTags.js";
import { NARRATOR_PROFILE } from "./speakerProfiles.js";
import { resolveTTSVoice } from "./voices.js";

export type TTSProviderId = "openai" | "openrouter";

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
  apiKeyEnvVar: "OPENAI_API_KEY" | "OPENROUTER_API_KEY";
  /** Whether the model honors the OpenAI `instructions` delivery field. */
  supportsDeliveryInstructions: boolean;
  /** Whether the model interprets bracketed inline delivery tags. */
  supportsInlineAudioTags: boolean;
  /** Largest narration text sent in a single speech request. */
  maxRequestChars: number;
}

export function resolveTTSProvider(env: NodeJS.ProcessEnv = process.env): TTSProviderId {
  return env.TTS_PROVIDER?.trim().toLowerCase() === "openrouter" ? "openrouter" : "openai";
}

export function resolveTTSProviderConfig(env: NodeJS.ProcessEnv = process.env): TTSProviderConfig {
  const provider = resolveTTSProvider(env);

  if (provider === "openrouter") {
    const model = env.TTS_MODEL?.trim() || DEFAULT_OPENROUTER_TTS_MODEL;
    return {
      provider,
      model,
      // OpenRouter voices are model-specific strings (e.g. Gemini's "Charon"),
      // so accept any non-empty override rather than the OpenAI voice list.
      voice: env.TTS_VOICE?.trim() || DEFAULT_OPENROUTER_TTS_VOICE,
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
    voice: resolveTTSVoice(env.TTS_VOICE, NARRATOR_PROFILE.defaultVoice),
    apiKeyEnvVar: "OPENAI_API_KEY",
    supportsDeliveryInstructions: supportsOpenAIDeliveryInstructions(model),
    supportsInlineAudioTags: false,
    maxRequestChars: OPENAI_MAX_REQUEST_CHARS,
  };
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
