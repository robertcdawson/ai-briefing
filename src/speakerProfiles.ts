import type { SpeakerId } from "./types.js";
import type { TTSVoice } from "./voices.js";

export type EpisodeSectionKind = "intro" | "story" | "outro";

export interface SpeakerProfile {
  id: SpeakerId;
  name: string;
  role: string;
  /** Writing persona for the script LLM. */
  persona: string;
  /** Default spoken delivery style for OpenAI TTS instructions. */
  delivery: string;
  defaultVoice: TTSVoice;
}

export const SPEAKER_PROFILES: Record<SpeakerId, SpeakerProfile> = {
  anchor: {
    id: "anchor",
    name: "The Anchor",
    role: "Host",
    persona:
      "The Anchor is concise, skeptical, fact-forward, and calm under uncertainty.",
    delivery:
      "Calm public-radio host; skeptical but not smug; medium-low energy; precise pacing; no hype.",
    defaultVoice: "cedar",
  },
  analyst: {
    id: "analyst",
    name: "The Analyst",
    role: "Analyst",
    persona:
      "The Analyst is warmer, more playful, and focused on why the story matters.",
    delivery:
      "Warm tech analyst; lightly amused; conversational; curious; uses subtle emphasis; never overacts.",
    defaultVoice: "marin",
  },
};

export const DEFAULT_GLOBAL_TTS_STYLE =
  "Daily 5-minute AI news podcast; clear, modern, intelligent; no announcer voice; no fake enthusiasm.";

export const DEFAULT_SECTION_TTS_STYLES: Record<EpisodeSectionKind, string> = {
  intro: "Slightly upbeat, crisp, confident.",
  story: "Measured, skeptical, clear.",
  outro: "Warm, concise, low-key.",
};

export interface TTSDirectionConfig {
  global: string;
  anchor: string;
  analyst: string;
  intro: string;
  story: string;
  outro: string;
}

const TTS_DIALOGUE_FOOTER =
  "Read naturally as podcast dialogue. Do not say speaker labels.";

export function resolveTTSDirection(env: NodeJS.ProcessEnv = process.env): TTSDirectionConfig {
  return {
    global: readStyleEnv(env.TTS_GLOBAL_STYLE) ?? DEFAULT_GLOBAL_TTS_STYLE,
    anchor: readStyleEnv(env.TTS_ANCHOR_STYLE) ?? SPEAKER_PROFILES.anchor.delivery,
    analyst: readStyleEnv(env.TTS_ANALYST_STYLE) ?? SPEAKER_PROFILES.analyst.delivery,
    intro: readStyleEnv(env.TTS_INTRO_STYLE) ?? DEFAULT_SECTION_TTS_STYLES.intro,
    story: readStyleEnv(env.TTS_STORY_STYLE) ?? DEFAULT_SECTION_TTS_STYLES.story,
    outro: readStyleEnv(env.TTS_OUTRO_STYLE) ?? DEFAULT_SECTION_TTS_STYLES.outro,
  };
}

export function buildTurnSpeechInstructions(
  speaker: SpeakerId,
  section: EpisodeSectionKind,
  direction: TTSDirectionConfig = resolveTTSDirection(),
): string {
  const profile = SPEAKER_PROFILES[speaker];
  const speakerStyle = speaker === "anchor" ? direction.anchor : direction.analyst;

  return [
    direction.global,
    `Speaker persona: ${profile.persona}`,
    `Delivery: ${speakerStyle}`,
    `Section: ${direction[section]}`,
    TTS_DIALOGUE_FOOTER,
  ].join("\n");
}

function readStyleEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
