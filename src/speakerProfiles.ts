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
  persona:
    "The Host is a sharp, witty solo guide to the day's AI news: curious and fair, occasionally cynical, and always weighing the real-world stakes — who benefits, who gets hurt, and what could go right or wrong.",
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
): string {
  return [
    direction.global,
    `Host: ${NARRATOR_PROFILE.persona}`,
    `Delivery: ${direction.narrator}`,
    `Section: ${direction[section]}`,
    TTS_DIALOGUE_FOOTER,
  ].join("\n");
}

function readStyleEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
