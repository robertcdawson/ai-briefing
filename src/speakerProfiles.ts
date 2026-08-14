import { HOST_IDENTITY } from "./voice.js";
import type { TTSVoice } from "./voices.js";

export type EpisodeSectionKind = "intro" | "story" | "outro";

export interface NarratorProfile {
  name: string;
  /** Writing persona for the script LLM. */
  persona: string;
  /** Default spoken delivery style for OpenAI TTS instructions. */
  delivery: string;
  defaultVoice: TTSVoice;
}

export const NARRATOR_PROFILE: NarratorProfile = {
  name: "The Host",
  // Single source of truth for "who the host is" shared with the script
  // writer's prompt (src/voice.ts HOST_IDENTITY feeds src/script.ts too).
  persona: HOST_IDENTITY.ttsPersonaLine,
  delivery:
    "Natural, conversational solo host; relaxed pace; dry wit; sounds like a smart person thinking out loud, not reading a bulletin.",
  defaultVoice: "marin",
};

export const DEFAULT_GLOBAL_TTS_STYLE =
  "Solo host of a daily AI news show; natural and conversational with dry wit; sounds like a smart person talking, not reading; relaxed pace, real intonation, uses contractions; never announcer-y or fake-enthusiastic.";

export const DEFAULT_SECTION_TTS_STYLES: Record<EpisodeSectionKind, string> = {
  intro: "Open with an easy, confident hook; warm but not hyped.",
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

const TTS_DIALOGUE_FOOTER =
  "Read naturally as a solo podcast monologue.";

export function resolveTTSDirection(env: NodeJS.ProcessEnv = process.env): TTSDirectionConfig {
  return {
    global: readStyleEnv(env.TTS_GLOBAL_STYLE) ?? DEFAULT_GLOBAL_TTS_STYLE,
    narrator: readStyleEnv(env.TTS_NARRATOR_STYLE) ?? NARRATOR_PROFILE.delivery,
    intro: readStyleEnv(env.TTS_INTRO_STYLE) ?? DEFAULT_SECTION_TTS_STYLES.intro,
    story: readStyleEnv(env.TTS_STORY_STYLE) ?? DEFAULT_SECTION_TTS_STYLES.story,
    outro: readStyleEnv(env.TTS_OUTRO_STYLE) ?? DEFAULT_SECTION_TTS_STYLES.outro,
  };
}

export function buildChunkSpeechInstructions(
  section: EpisodeSectionKind,
  direction: TTSDirectionConfig = resolveTTSDirection(),
  segmentHint?: string,
): string {
  const sanitizedHint = sanitizeSegmentDeliveryHint(segmentHint);
  return [
    direction.global,
    `Host: ${NARRATOR_PROFILE.persona}`,
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
