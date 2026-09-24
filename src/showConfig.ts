/**
 * Show config — the listener-editable voice and tone.
 *
 * `src/voice.ts` and `src/speakerProfiles.ts` hold the built-in defaults.
 * `config/show.json` overrides them. The tune page (`docs/tune/`) commits
 * that file straight to main, so the next morning's run picks up the edit
 * without a pull request or an Actions variable change.
 *
 * A blank field falls back to the built-in. A missing or unreadable file
 * falls back entirely. Environment variables for TTS delivery
 * (`TTS_NARRATOR_STYLE` and the other `TTS_*` style vars, plus `TTS_VOICE`)
 * still win when they are non-empty, so an old Actions variable is not
 * silently ignored.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_GLOBAL_TTS_STYLE,
  DEFAULT_SECTION_TTS_STYLES,
  NARRATOR_PROFILE,
} from "./speakerProfiles.js";
import { HOST_IDENTITY, VOICE_EXEMPLARS, type HostIdentity } from "./voice.js";
import { logJson } from "./util.js";

export const SHOW_CONFIG_PATH = "config/show.json";

export const HOST_FIELD_MAX = 2000;
export const TONE_NOTES_MAX = 4000;
export const EXEMPLAR_MAX = 900;
export const EXEMPLARS_MAX = 8;
export const TTS_FIELD_MAX = 600;
export const VOICE_MAX = 80;

export interface ShowTts {
  /** Empty means the provider default. A non-empty TTS_VOICE env var wins. */
  voice: string;
  global: string;
  narrator: string;
  intro: string;
  story: string;
  outro: string;
}

export interface ShowConfig {
  version: 1;
  host: HostIdentity;
  exemplars: readonly string[];
  /** Empty means no extra tone block in the script or ear-edit prompts. */
  toneNotes: string;
  tts: ShowTts;
}

export interface ParsedShowConfig {
  config: ShowConfig;
  truncated: boolean;
}

export function builtinShowConfig(): ShowConfig {
  return {
    version: 1,
    host: { ...HOST_IDENTITY },
    exemplars: [...VOICE_EXEMPLARS],
    toneNotes: "",
    tts: {
      voice: "",
      global: DEFAULT_GLOBAL_TTS_STYLE,
      narrator: NARRATOR_PROFILE.delivery,
      intro: DEFAULT_SECTION_TTS_STYLES.intro,
      story: DEFAULT_SECTION_TTS_STYLES.story,
      outro: DEFAULT_SECTION_TTS_STYLES.outro,
    },
  };
}

/**
 * Merge a parsed JSON value over the built-in show. Throws when the root
 * value is not an object. Individual bad fields fall back rather than
 * rejecting the whole file.
 */
export function parseShowConfig(raw: unknown): ParsedShowConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("show config must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  const truncated = { value: false };
  const base = builtinShowConfig();
  const hostRaw = isRecord(record.host) ? record.host : {};
  const ttsRaw = isRecord(record.tts) ? record.tts : {};

  const config: ShowConfig = {
    version: 1,
    host: {
      name: textField(hostRaw.name, base.host.name, HOST_FIELD_MAX, truncated),
      background: textField(hostRaw.background, base.host.background, HOST_FIELD_MAX, truncated),
      beat: textField(hostRaw.beat, base.host.beat, HOST_FIELD_MAX, truncated),
      caresAbout: textField(hostRaw.caresAbout, base.host.caresAbout, HOST_FIELD_MAX, truncated),
      speech: textField(hostRaw.speech, base.host.speech, HOST_FIELD_MAX, truncated),
      humor: textField(hostRaw.humor, base.host.humor, HOST_FIELD_MAX, truncated),
      refusals: textField(hostRaw.refusals, base.host.refusals, HOST_FIELD_MAX, truncated),
      ttsPersonaLine: textField(hostRaw.ttsPersonaLine, base.host.ttsPersonaLine, HOST_FIELD_MAX, truncated),
    },
    exemplars: parseExemplars(record.exemplars, truncated),
    toneNotes: optionalText(record.toneNotes, TONE_NOTES_MAX, truncated),
    tts: {
      voice: optionalText(ttsRaw.voice, VOICE_MAX, truncated),
      global: textField(ttsRaw.global, base.tts.global, TTS_FIELD_MAX, truncated),
      narrator: textField(ttsRaw.narrator, base.tts.narrator, TTS_FIELD_MAX, truncated),
      intro: textField(ttsRaw.intro, base.tts.intro, TTS_FIELD_MAX, truncated),
      story: textField(ttsRaw.story, base.tts.story, TTS_FIELD_MAX, truncated),
      outro: textField(ttsRaw.outro, base.tts.outro, TTS_FIELD_MAX, truncated),
    },
  };
  return { config, truncated: truncated.value };
}

/**
 * Listener tone notes, appended at the end of a prompt so they win over
 * the default register. Empty notes return "" so the prompt is unchanged.
 */
export function formatListenerToneNotes(notes: string, role: "writer" | "editor"): string {
  const trimmed = notes.trim();
  if (!trimmed) return "";
  const job =
    role === "writer"
      ? "Follow them for wording, rhythm, and what to avoid. They outrank the default register, the emphasis budget, and any dialect habit in this prompt when they conflict."
      : "Preserve wording that follows them. Do not sand the script back into a generic newsreader, and do not add dialect the notes told you to drop.";
  return `\n\nLISTENER TONE NOTES\nThe listener writes these between episodes, after hearing the show. ${job} They do not outrank factual accuracy: never invent, drop, or soften a sourced fact to satisfy a note. Do not quote these notes on air.\n\n${trimmed}`;
}

/**
 * Read `config/show.json` from the repo root (or `filePath`). Never throws:
 * a missing or invalid file logs and returns the built-in show.
 */
export async function loadShowConfig(filePath = defaultShowConfigPath()): Promise<ShowConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    logJson({
      phase: "show-config",
      status: "fallback",
      reason: code === "ENOENT" ? "missing" : "unreadable",
    });
    return builtinShowConfig();
  }

  try {
    const parsed = parseShowConfig(JSON.parse(raw) as unknown);
    logJson({
      phase: "show-config",
      status: "loaded",
      toneNotes: parsed.config.toneNotes.length > 0,
      truncated: parsed.truncated,
    });
    return parsed.config;
  } catch (err) {
    logJson({
      phase: "show-config",
      status: "fallback",
      reason: "invalid",
      error: err instanceof Error ? err.message : String(err),
    });
    return builtinShowConfig();
  }
}

export function defaultShowConfigPath(): string {
  return path.resolve(process.cwd(), SHOW_CONFIG_PATH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textField(
  value: unknown,
  fallback: string,
  max: number,
  truncated: { value: boolean },
): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return clip(trimmed, max, truncated);
}

function optionalText(value: unknown, max: number, truncated: { value: boolean }): string {
  if (typeof value !== "string") return "";
  return clip(value.trim(), max, truncated);
}

function clip(value: string, max: number, truncated: { value: boolean }): string {
  if (value.length <= max) return value;
  truncated.value = true;
  return value.slice(0, max).trim();
}

function parseExemplars(value: unknown, truncated: { value: boolean }): readonly string[] {
  if (!Array.isArray(value)) return [...VOICE_EXEMPLARS];
  const cleaned: string[] = [];
  for (const item of value) {
    if (cleaned.length >= EXEMPLARS_MAX) {
      truncated.value = true;
      break;
    }
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const clipped = clip(trimmed, EXEMPLAR_MAX, truncated);
    if (clipped) cleaned.push(clipped);
  }
  return cleaned.length > 0 ? cleaned : [...VOICE_EXEMPLARS];
}
