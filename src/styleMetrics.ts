/**
 * Pure style-drift metrics computed from episode narration text: per-episode
 * sentence-length shape, rhetorical-device density, and metadiscourse-marker
 * counts, plus cross-episode repeated-phrase detection (built on
 * src/ngrams.ts). No fs access — src/ledger.ts and scripts/style-report.ts
 * supply the text. Read-only reporting; nothing here gates the pipeline.
 */
import { collectGramEpisodes, isAllStopwords } from "./ngrams.js";

export interface EpisodeText {
  episodeDate: string;
  narrationText: string;
}

export interface EpisodeStyleMetrics {
  episodeDate: string;
  wordCount: number;
  sentenceCount: number;
  meanSentenceWords: number;
  sentenceWordVariance: number;
  antithesisCount: number;
  triadCount: number;
  metadiscourseCount: number;
}

export interface RepeatedGram {
  gram: string;
  episodeCount: number;
  dates: string[];
}

export interface StyleReport {
  episodes: EpisodeStyleMetrics[];
  repeatedGrams: RepeatedGram[];
}

export interface ComputeStyleReportOptions {
  /** Minimum episodes a gram must appear in to be reported (default 3). */
  minEpisodes?: number;
  markers?: readonly string[];
}

/** Self-congratulatory / throat-clearing tics that read as AI-authored. */
export const DEFAULT_METADISCOURSE_MARKERS: readonly string[] = [
  "worth noting",
  "worth watching",
  "worth sitting with",
  "the takeaway",
  "the honest",
  "here's the thing",
  "let me be clear",
  "the truth is",
  "that's the part",
  "the real story",
  "and that matters",
  "which is exactly the point",
  "at the end of the day",
  "in short",
];

/**
 * Case-insensitive antithesis-family patterns, each matched against the full
 * narration text (not pre-split into sentences) since several of these shapes
 * span two sentences.
 */
export const ANTITHESIS_PATTERNS: readonly RegExp[] = [
  // "not X but Y"
  /\bnot\b[^.!?]{1,60}\bbut\b/i,
  // "That's not X. That's Y." / "It isn't X; it's Y." — mirrors the shape of
  // the split-contrast hard-fail validator in src/script.ts (not imported:
  // that pattern is tuned for a validator; this one is a looser style metric).
  /\b(?:that|this|it)(?:\s+is|\s*['’]s)\s+not\b[^.!?;]{0,160}(?:[.!?]\s+|;\s*)(?:it|that|this|they)(?:\s+is|\s*['’]re|\s*['’]s)\b/i,
  // "less a hammer, more a scalpel"
  /\bless\b[^.!?]{1,40}\b(?:more|than)\b/i,
  // "no longer X. It's/They're Y"
  /\bno longer\b[^.!?]{1,60}[.!?]\s+(?:it|they)['’]?(?:s|re)\b/i,
];

/** "X, Y, and Z" list-of-three shape. */
const TRIAD_PATTERN = /,\s+[^,.!?]{2,40},\s+and\s+/i;

export function computeEpisodeStyleMetrics(
  ep: EpisodeText,
  markers: readonly string[] = DEFAULT_METADISCOURSE_MARKERS,
): EpisodeStyleMetrics {
  const sentences = splitSentences(ep.narrationText);
  const sentenceWordCounts = sentences.map((sentence) => countWords(sentence));
  const wordCount = sentenceWordCounts.reduce((sum, n) => sum + n, 0);
  const sentenceCount = sentences.length;
  const meanSentenceWords = sentenceCount > 0 ? wordCount / sentenceCount : 0;
  const sentenceWordVariance =
    sentenceCount > 0
      ? sentenceWordCounts.reduce((sum, n) => sum + (n - meanSentenceWords) ** 2, 0) / sentenceCount
      : 0;

  return {
    episodeDate: ep.episodeDate,
    wordCount,
    sentenceCount,
    meanSentenceWords,
    sentenceWordVariance,
    antithesisCount: countPatternMatches(ep.narrationText, ANTITHESIS_PATTERNS),
    triadCount: countPatternMatches(ep.narrationText, [TRIAD_PATTERN]),
    metadiscourseCount: countMarkerHits(ep.narrationText, markers),
  };
}

/**
 * Per-episode metrics plus grams appearing in at least `minEpisodes` (default
 * 3) of the supplied episodes. Read-only report; does not enforce anything.
 */
export function computeStyleReport(
  episodes: readonly EpisodeText[],
  opts: ComputeStyleReportOptions = {},
): StyleReport {
  const minEpisodes = opts.minEpisodes ?? 3;
  const markers = opts.markers ?? DEFAULT_METADISCOURSE_MARKERS;

  const episodeMetrics = episodes.map((ep) => computeEpisodeStyleMetrics(ep, markers));

  const gramEpisodes = collectGramEpisodes(
    episodes.map((ep) => ({ episodeDate: ep.episodeDate, text: ep.narrationText })),
  );

  const repeatedGrams: RepeatedGram[] = [];
  for (const [gram, dates] of gramEpisodes) {
    if (isAllStopwords(gram)) continue;
    if (dates.size < minEpisodes) continue;
    repeatedGrams.push({ gram, episodeCount: dates.size, dates: [...dates].sort() });
  }
  repeatedGrams.sort((a, b) => b.episodeCount - a.episodeCount || a.gram.localeCompare(b.gram));

  return { episodes: episodeMetrics, repeatedGrams };
}

function splitSentences(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countPatternMatches(text: string, patterns: readonly RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const matches = text.match(new RegExp(pattern.source, flags));
    count += matches ? matches.length : 0;
  }
  return count;
}

function countMarkerHits(text: string, markers: readonly string[]): number {
  const haystack = text.toLowerCase();
  let count = 0;
  for (const marker of markers) {
    count += countOccurrences(haystack, marker.toLowerCase());
  }
  return count;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  for (;;) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}
