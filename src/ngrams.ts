/**
 * Pure n-gram extraction shared by the phrase tripwire (src/ledger.ts) and the
 * style-metrics report (src/styleMetrics.ts, scripts/style-report.ts). No fs
 * access here — callers supply already-loaded text.
 */

/** Common function words excluded from n-gram repetition detection. */
export const NGRAM_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the",
  "and", "but", "or", "nor", "so", "yet",
  "of", "to", "in", "on", "at", "for", "with", "by", "from", "as", "into", "onto", "over", "under",
  "up", "down", "out", "off", "about", "after", "before", "between", "through", "during",
  "is", "was", "are", "were", "be", "been", "being", "am",
  "it", "its", "this", "that", "these", "those",
  "he", "she", "they", "we", "you", "i", "him", "her", "them", "us",
  "his", "their", "our", "your", "my", "mine", "hers", "ours", "yours", "theirs",
  "not", "no", "nor", "if", "then", "than", "when", "where", "who", "whom", "which", "what", "why", "how",
  "will", "would", "can", "could", "should", "shall", "may", "might", "must",
  "has", "have", "had", "do", "does", "did", "done",
  "all", "any", "some", "more", "most", "both", "each", "few", "other", "such",
  "only", "own", "same", "too", "very", "just", "also", "one", "two", "three",
  "there", "here", "now", "still", "even", "back", "again",
]);

/**
 * Lowercases, converts hyphens/dashes to spaces, strips apostrophes and all
 * remaining punctuation, and collapses whitespace. Intended per-sentence, not
 * per-document (callers split on sentence boundaries first so grams never
 * span them).
 */
export function normalizeForNgrams(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-‐-―]/g, " ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts all n-word sliding-window grams from `text`. Splits on sentence
 * boundaries (. ! ? ; :) first so a gram never straddles two sentences, then
 * normalizes and tokenizes each span independently.
 */
export function extractNgrams(text: string, n: number): string[] {
  if (n <= 0) return [];
  const grams: string[] = [];
  for (const span of text.split(/[.!?;:]+/)) {
    const words = normalizeForNgrams(span).split(" ").filter(Boolean);
    for (let i = 0; i + n <= words.length; i += 1) {
      grams.push(words.slice(i, i + n).join(" "));
    }
  }
  return grams;
}

/** True when every word in a (space-joined) gram is a stopword. */
export function isAllStopwords(gram: string): boolean {
  const words = gram.split(" ").filter(Boolean);
  if (words.length === 0) return true;
  return words.every((word) => NGRAM_STOPWORDS.has(word));
}

/**
 * For each episode, extracts n-grams (default 3- and 4-word) from its text
 * and records which episodes contain each gram. A gram repeated multiple
 * times within one episode still counts as appearing in that episode once —
 * this tracks episode coverage, not raw occurrence count.
 */
export function collectGramEpisodes(
  episodes: readonly { episodeDate: string; text: string }[],
  ns: readonly number[] = [3, 4],
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();

  for (const episode of episodes) {
    const seenInEpisode = new Set<string>();
    for (const n of ns) {
      for (const gram of extractNgrams(episode.text, n)) {
        seenInEpisode.add(gram);
      }
    }
    for (const gram of seenInEpisode) {
      let dates = result.get(gram);
      if (!dates) {
        dates = new Set<string>();
        result.set(gram, dates);
      }
      dates.add(episode.episodeDate);
    }
  }

  return result;
}
