/**
 * Pronunciation lexicon (M9).
 *
 * AI news is unusually dense with names TTS engines mangle — model/lab names,
 * brands, and researchers. `gpt-4o-mini-tts` has NO SSML support (and we also
 * route through OpenRouter TTS), so the provider-agnostic fix is to RESPELL the
 * offending term phonetically in the text we send to the synthesizer.
 *
 * IMPORTANT: this transform is applied ONLY to the audio input at the TTS
 * synthesis boundary (src/tts.ts buildPartSpeechRequest). The canonical script,
 * episode data, transcript, and chapters keep the correct spelling — only the
 * spoken audio gets the respelled form.
 *
 * Editing: add/adjust entries below. `term` is the canonical spelling as it
 * appears in scripts; `say` is what the voice should actually say. Matching is
 * whole-word and case-insensitive, so one entry covers all casings.
 */

export interface Pronunciation {
  /** Canonical spelling as written in scripts. */
  term: string;
  /** Phonetic respelling fed to the TTS engine. */
  say: string;
}

export const PRONUNCIATIONS: Pronunciation[] = [
  { term: "Qwen", say: "Chwen" },
  { term: "Mistral", say: "Miss-trahl" },
  { term: "Mixtral", say: "Mix-trahl" },
  { term: "Groq", say: "Grock" },
  { term: "Grok", say: "Grock" },
  { term: "Nvidia", say: "En-vid-ee-uh" },
  { term: "vLLM", say: "V-L-L-M" },
  { term: "Jensen Huang", say: "Jensen Hwang" },
  { term: "Yann LeCun", say: "Yann Luh-Kuhn" },
  { term: "Demis Hassabis", say: "Demis Huh-sah-biss" },
  { term: "Sundar Pichai", say: "Sundar Pih-chai" },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Respell known terms for the TTS engine.
 *
 * Whole-word, case-insensitive replacement that preserves surrounding
 * punctuation and spacing. Guards against substring false positives via word
 * boundaries (a term "AI" never matches inside "rain"). Longer terms are applied
 * first so a multi-word entry wins over any shorter overlapping one. Returns the
 * input unchanged when the lexicon is empty or nothing matches.
 */
export function applyPronunciations(
  text: string,
  lexicon: Pronunciation[] = PRONUNCIATIONS,
): string {
  const entries = lexicon.filter((e) => e.term);
  if (!text || entries.length === 0) return text;

  // Longest term first so a multi-word name wins over a single-word overlap at
  // the same position (regex alternation is first-match-wins).
  const ordered = [...entries].sort((a, b) => b.term.length - a.term.length);
  const sayFor = new Map(ordered.map((e) => [e.term.toLowerCase(), e.say]));

  // Single pass over the ORIGINAL text via one alternation regex. Replacing in
  // one pass (rather than term-by-term) is essential: a sequential pass would
  // re-scan already-substituted output and let a shorter term match text a
  // longer term just produced (e.g. "Yann" inside the respelled "Yann Luh-Kuhn").
  const pattern = ordered.map((e) => escapeRegExp(e.term)).join("|");
  const re = new RegExp(`\\b(?:${pattern})\\b`, "gi");
  return text.replace(re, (match) => sayFor.get(match.toLowerCase()) ?? match);
}
