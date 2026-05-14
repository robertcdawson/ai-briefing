export type TTSVoice =
  | "alloy" | "ash" | "ballad" | "cedar" | "coral" | "echo" | "fable"
  | "marin" | "nova" | "onyx" | "sage" | "shimmer" | "verse";

export const VALID_TTS_VOICES: readonly TTSVoice[] = [
  "alloy", "ash", "ballad", "cedar", "coral", "echo", "fable",
  "marin", "nova", "onyx", "sage", "shimmer", "verse",
];

export function resolveTTSVoice(value: string | undefined, fallback: TTSVoice): TTSVoice {
  return VALID_TTS_VOICES.includes(value as TTSVoice) ? value as TTSVoice : fallback;
}
