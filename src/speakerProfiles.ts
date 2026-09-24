import { HOST_IDENTITY } from "./voice.js";
import type { TTSVoice } from "./voices.js";

export type EpisodeSectionKind = "intro" | "story" | "outro";

export interface NarratorProfile {
  name: string;
  /** Writing persona for the script LLM. */
  persona: string;
  /**
   * Default spoken delivery style for OpenAI TTS instructions. The host's
   * Southern accent lives here. config/show.json overrides it, and a non-empty
   * TTS_NARRATOR_STYLE wins over the file. The words of the dialect live in
   * src/voice.ts (also overridable from the tune page).
   */
  delivery: string;
  defaultVoice: TTSVoice;
}

export const NARRATOR_PROFILE: NarratorProfile = {
  name: "The Host",
  // Single source of truth for "who the host is" shared with the script
  // writer's prompt (src/voice.ts HOST_IDENTITY feeds src/script.ts too).
  persona: HOST_IDENTITY.ttsPersonaLine,
  delivery:
    "Natural, conversational solo host with an unhurried Southern American accent: a soft, understated drawl, relaxed vowels, easy pace, dry humor; sounds like a smart neighbor thinking out loud, not reading a bulletin. Keep the accent consistent and understated across the whole read, never a caricature.",
  defaultVoice: "cedar",
};

export const DEFAULT_GLOBAL_TTS_STYLE =
  "Solo host of a daily AI news show; natural and conversational with dry wit; sounds like a smart person talking, not reading; relaxed pace, real intonation, uses contractions; never announcer-y or fake-enthusiastic.";

export const DEFAULT_SECTION_TTS_STYLES: Record<EpisodeSectionKind, string> = {
  intro: "Open easy and confident, like catching a friend up; warm but not hyped.",
  story: "Measured, curious, and clear; let the stakes land.",
  outro: "Warm, reflective, low-key sign-off.",
};

export interface TTSDirectionConfig {
  global: string;
  narrator: string;
  intro: string;
  story: string;
  outro: string;
}

/** Spoken-delivery text from config/show.json. Blank fields are ignored. */
export interface TTSStyleOverride {
  global?: string;
  narrator?: string;
  intro?: string;
  story?: string;
  outro?: string;
}

const TTS_DIALOGUE_FOOTER =
  "Read naturally as a solo podcast monologue.";

export function resolveTTSDirection(
  env: NodeJS.ProcessEnv = process.env,
  file?: TTSStyleOverride,
): TTSDirectionConfig {
  return {
    global: readStyleEnv(env.TTS_GLOBAL_STYLE) ?? readStyleEnv(file?.global) ?? DEFAULT_GLOBAL_TTS_STYLE,
    narrator: readStyleEnv(env.TTS_NARRATOR_STYLE) ?? readStyleEnv(file?.narrator) ?? NARRATOR_PROFILE.delivery,
    intro: readStyleEnv(env.TTS_INTRO_STYLE) ?? readStyleEnv(file?.intro) ?? DEFAULT_SECTION_TTS_STYLES.intro,
    story: readStyleEnv(env.TTS_STORY_STYLE) ?? readStyleEnv(file?.story) ?? DEFAULT_SECTION_TTS_STYLES.story,
    outro: readStyleEnv(env.TTS_OUTRO_STYLE) ?? readStyleEnv(file?.outro) ?? DEFAULT_SECTION_TTS_STYLES.outro,
  };
}

export function buildChunkSpeechInstructions(
  section: EpisodeSectionKind,
  direction: TTSDirectionConfig = resolveTTSDirection(),
  segmentHint?: string,
  persona: string = NARRATOR_PROFILE.persona,
): string {
  const sanitizedHint = sanitizeSegmentDeliveryHint(segmentHint);
  const hostPersona = persona.trim() || NARRATOR_PROFILE.persona;
  return [
    direction.global,
    `Host: ${hostPersona}`,
    `Delivery: ${direction.narrator}`,
    `Section: ${direction[section]}`,
    ...(sanitizedHint ? [`This segment: ${sanitizedHint}`] : []),
    TTS_DIALOGUE_FOOTER,
  ].join("\n");
}

const MAX_SEGMENT_DELIVERY_HINT_LENGTH = 60;

/**
 * Sanitizes a writer-supplied per-segment delivery hint before it reaches a
 * TTS `instructions` field: strips brackets and newlines (this must never
 * become a stage direction or a stray inline audio tag), collapses
 * whitespace, and caps length. Returns undefined for anything that reduces
 * to nothing.
 */
export function sanitizeSegmentDeliveryHint(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const cleaned = hint
    .replace(/[[\]{}<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > MAX_SEGMENT_DELIVERY_HINT_LENGTH
    ? cleaned.slice(0, MAX_SEGMENT_DELIVERY_HINT_LENGTH).trim()
    : cleaned;
}

function readStyleEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
