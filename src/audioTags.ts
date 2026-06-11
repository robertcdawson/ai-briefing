/**
 * Inline delivery tags for expressive TTS models (e.g. Gemini 3.1 Flash TTS),
 * which interpret bracketed cues like "[chuckles]" as performance hints rather
 * than spoken text. The allow-list is intentionally small and editorially safe
 * for a news show; it is shared by the script prompt (which permits only these
 * tags), the TTS layer (which strips them for models that would read them
 * aloud), and the transcript writer.
 */
export const ALLOWED_INLINE_AUDIO_TAGS = [
  "[chuckles]",
  "[sighs]",
  "[curious]",
  "[skeptical]",
  "[excited]",
  "[deadpan]",
] as const;

export type InlineAudioTag = (typeof ALLOWED_INLINE_AUDIO_TAGS)[number];

const TAG_PATTERN = new RegExp(
  ALLOWED_INLINE_AUDIO_TAGS.map((tag) => escapeRegExp(tag)).join("|"),
  "g",
);

/** Models whose voice engine interprets bracketed inline delivery tags. */
export function supportsInlineAudioTags(model: string): boolean {
  return /gemini[^/]*-tts/i.test(model);
}

/**
 * Remove approved inline delivery tags from narration text, for transcripts
 * and for TTS models that would read the brackets aloud. Only the allow-list
 * is removed so legitimate bracketed text is preserved.
 */
export function stripInlineAudioTags(text: string): string {
  return text
    .replace(TAG_PATTERN, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "");
}

/** Prompt rules appended to the script system prompt when tags are enabled. */
export function buildInlineAudioTagRules(): string {
  const tagList = ALLOWED_INLINE_AUDIO_TAGS.join(", ");
  return `Inline delivery tags:
- You MAY insert inline delivery tags chosen ONLY from this set: ${tagList}. The voice engine interprets them as performance hints; they are never read aloud.
- Use at most one tag per story segment, at most one in the intro, and at most one in the outro. Most chunks should carry no tag.
- Place a tag immediately before the sentence it colors, and only where it genuinely sharpens delivery. Never stack two tags.`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
