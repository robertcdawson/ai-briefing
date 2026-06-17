import OpenAI from "openai";
import { STORY_CATEGORY_DEFINITIONS } from "./types.js";
import type { Article, StoryCluster } from "./types.js";
import { loadRecentCoverage } from "./ledger.js";
import type { PriorCoverageEntry } from "./ledger.js";
import { getChatCompletionAssistantText, logJson, withHardTimeout, withRetry } from "./util.js";

const MODEL = "anthropic/claude-sonnet-4.6";
const TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
// Variable story count: include everything that clears the bar, capped so the
// episode stays under ~10 minutes. On a slow day this can be as few as one story.
const IMPORTANCE_THRESHOLD = 45;
const MAX_STORIES = 6;
const MIN_STORIES = 1;
// Upper bound on clusters the model returns. Bounding the structured output
// keeps curation latency in check (an unbounded list of every story balloons
// generation time and can blow the request timeout); the code still narrows to
// MAX_STORIES afterward.
const MODEL_CLUSTER_LIMIT = 8;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    clusters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          canonicalKey: {
            type: "string",
            description: "kebab-case slug, e.g. 'openai-releases-tts-3'",
          },
          category: {
            type: "string",
            enum: STORY_CATEGORY_DEFINITIONS.map((category) => category.id),
            description: "Primary editorial lane for this story.",
          },
          headline: {
            type: "string",
            description: "8-14 word neutral framing of the story",
          },
          whyItMatters: {
            type: "string",
            description: "1-2 sentences on significance for AI builders/researchers",
          },
          caveat: {
            type: "string",
            description: "1 sentence on what's uncertain, missing, or potentially overhyped",
          },
          importance: {
            type: "number",
            description: "0-100 importance score for ranking",
          },
          sources: {
            type: "array",
            items: {
              type: "object",
              properties: {
                url: { type: "string" },
                publisher: { type: "string" },
              },
              required: ["url", "publisher"],
              additionalProperties: false,
            },
          },
          // F1: followUp is nullable+required for OpenAI strict-mode compatibility
          // (OpenRouter only; nullable+required is the OpenAI-strict-compatible form for
          // an optional object field — the model emits null for non-follow-up stories).
          followUp: {
            type: ["object", "null"],
            description: "Present only when this cluster is a follow-up to a previously covered story. Null otherwise.",
            properties: {
              priorDate: {
                type: "string",
                description: "YYYY-MM-DD date of the episode that previously covered this story",
              },
              priorFraming: {
                type: "string",
                description: "Brief (1 sentence) recall of what was said about this story before",
              },
            },
            required: ["priorDate", "priorFraming"],
            additionalProperties: false,
          },
        },
        required: [
          "canonicalKey",
          "category",
          "headline",
          "whyItMatters",
          "caveat",
          "importance",
          "sources",
          "followUp",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["clusters"],
  additionalProperties: false,
} as const;

export function buildSystemPrompt(): string {
  const categoryLines = STORY_CATEGORY_DEFINITIONS
    .map((category) => `- ${category.label} (${category.id}): ${category.prompt}`)
    .join("\n");

  return `You are the editor for a daily AI news podcast. Given a list of recent articles from various publishers, your job is to:

1. CLUSTER articles about the same underlying story (e.g., multiple outlets covering one product launch). Group them by canonical story.
2. SCAN every editorial lane before selecting stories, so the show does not miss strong category-specific news:
${categoryLines}
3. SCORE each cluster's audience impact for researchers, builders, and technical leaders on a 0-100 scale. Weight practical usefulness, strategic consequence, evidence quality, and timeliness above novelty; novelty is only a tiebreaker. Down-weight SEO clickbait, thin rewrites, listicles, and pure opinion.
4. RETURN the strongest distinct, credible stories as separate clusters — at most ${MODEL_CLUSTER_LIMIT}, fewer when the day is quiet — each with an honest importance score. Prefer a diverse mix of categories. Never pad with weak material: if it isn't worth a listener's time, leave it out. A slow day may yield only one or two strong stories.
5. SUPPRESS already-covered stories: if today's articles revisit a story from the recently-covered list below, omit that cluster UNLESS it has materially developed (new facts, confirmed outcomes, significant escalation). When UNCERTAIN whether it developed enough, PREFER including it as a short follow-up rather than dropping it — bias toward surfacing. ALWAYS surface a major escalation even if you covered it recently.
6. When threading a follow-up (a story that recurred with material development), emit a "followUp" field on that cluster containing: priorDate (the episode date from the recently-covered list) and priorFraming (a 1-sentence recall of what was said before).

For each cluster:
- canonicalKey: short kebab-case slug
- category: one of the editorial lane ids above
- headline: 8-14 word neutral framing
- whyItMatters: 1-2 sentences on significance for AI builders/researchers
- caveat: 1 sentence on what's uncertain, missing, or potentially overhyped
- sources: every article in the cluster as {url, publisher}
- followUp (optional): only when this is a follow-up to a recently-covered story

Return only JSON matching the provided schema. No prose outside the JSON.`;
}

// Maximum lines to include in the prior-coverage block (F9 cap).
const MAX_PRIOR_COVERAGE_LINES = 40;
// Maximum character length for a single prior-coverage line (F9 compactness).
const MAX_PRIOR_LINE_LENGTH = 200;

/**
 * Builds a compact "recently covered" block for the user prompt.
 * Returns an empty string when the prior coverage list is empty so that
 * the block is completely absent from the prompt on a cold run.
 *
 * @param priorCoverage  List of prior coverage entries.
 * @param windowDays     Window size in days (default 14); interpolated into the header.
 */
export function buildPriorCoverageBlock(priorCoverage: PriorCoverageEntry[], windowDays = 14): string {
  if (priorCoverage.length === 0) return "";

  // F9: sort by episodeDate descending and cap at MAX_PRIOR_COVERAGE_LINES
  const sorted = [...priorCoverage].sort((a, b) => b.episodeDate.localeCompare(a.episodeDate));
  const capped = sorted.slice(0, MAX_PRIOR_COVERAGE_LINES);

  const lines = capped.map((e) => {
    const headline = e.headline.trim().slice(0, 80);
    const caveat = e.caveat.trim().slice(0, 80);
    const line = `  ${e.episodeDate} | ${e.canonicalKey} | ${headline} | caveat: ${caveat}`;
    // Ensure the whole line stays compact
    return line.length > MAX_PRIOR_LINE_LENGTH ? line.slice(0, MAX_PRIOR_LINE_LENGTH) : line;
  });
  // F6: interpolate actual windowDays into the header string
  return `\nRecently covered (last ${windowDays} days — suppress unless materially developed):\n${lines.join("\n")}\n`;
}

export function buildUserPrompt(articles: Article[], priorCoverage: PriorCoverageEntry[] = [], windowDays = 14): string {
  const lines = articles.map((a, i) => {
    const excerpt = a.excerpt.replace(/\s+/g, " ").trim();
    return `[${i + 1}] (${a.source}) ${a.title}\n    URL: ${a.url}\n    Excerpt: ${excerpt}`;
  });
  const articleBlock = `Articles from the last 24 hours (${articles.length} total):\n\n${lines.join("\n\n")}`;
  // F6: thread windowDays through so the prompt text matches the real window
  const priorBlock = buildPriorCoverageBlock(priorCoverage, windowDays);
  return priorBlock ? `${priorBlock}\n${articleBlock}` : articleBlock;
}

/**
 * Rank scored clusters and pick a variable number for the episode: clamp each
 * importance into [0,100], sort high-to-low, keep everything that clears the bar
 * (capped at MAX_STORIES), and if nothing clears it keep the single strongest
 * story so a slow day still produces a show.
 */
export function selectStoryClusters(
  clusters: readonly (StoryCluster & { importance?: number })[],
): StoryCluster[] {
  const ranked = clusters
    .map((c) => ({ ...c, importance: clampImportance(c.importance) }))
    .sort((a, b) => b.importance - a.importance);

  const aboveBar = ranked.filter((c) => c.importance >= IMPORTANCE_THRESHOLD);
  const selected = aboveBar.length >= MIN_STORIES ? aboveBar : ranked.slice(0, MIN_STORIES);
  return selected.slice(0, MAX_STORIES);
}

function clampImportance(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value as number));
}

export interface ThreadingTally {
  newCount: number;
  followUpCount: number;
  /** Count of prior-coverage canonicalKeys absent from today's selected clusters.
   * Upper bound on suppression: a key may simply be absent from today's feed,
   * not necessarily suppressed by the model. */
  priorKeysNotResurfacedCount: number;
  /** Prior-coverage canonicalKeys absent from today's selection (upper bound on
   * suppression — a key may simply be absent from today's article feed). */
  priorKeysNotResurfaced: string[];
}

/**
 * Computes a tally of how selected clusters relate to prior coverage.
 *
 * - followUpCount: clusters in `selectedClusters` that have a `followUp` field.
 * - newCount: clusters without a `followUp` field.
 * - priorKeysNotResurfaced / priorKeysNotResurfacedCount: canonicalKeys from
 *   `priorCoverage` that do NOT appear (as any cluster key) among
 *   `selectedClusters`. This is an upper bound on suppression — a prior key
 *   absent from today's selection may simply be absent from today's feeds.
 */
export function computeThreadingTally(
  selectedClusters: readonly StoryCluster[],
  priorCoverage: readonly PriorCoverageEntry[],
): ThreadingTally {
  let followUpCount = 0;
  let newCount = 0;

  for (const cluster of selectedClusters) {
    if (cluster.followUp != null) {
      followUpCount++;
    } else {
      newCount++;
    }
  }

  const selectedKeys = new Set(selectedClusters.map((c) => c.canonicalKey));
  const priorKeysNotResurfaced: string[] = [];
  const seenPriorKeys = new Set<string>();
  for (const entry of priorCoverage) {
    if (seenPriorKeys.has(entry.canonicalKey)) continue;
    seenPriorKeys.add(entry.canonicalKey);
    if (!selectedKeys.has(entry.canonicalKey)) {
      priorKeysNotResurfaced.push(entry.canonicalKey);
    }
  }

  return { newCount, followUpCount, priorKeysNotResurfacedCount: priorKeysNotResurfaced.length, priorKeysNotResurfaced };
}

/**
 * Normalise raw LLM cluster objects into StoryCluster, carrying through any
 * followUp field the model emitted.
 */
export function normaliseCluster(
  raw: StoryCluster & { importance?: number; followUp?: { priorDate: string; priorFraming: string } | null },
): StoryCluster & { importance?: number } {
  const result: StoryCluster & { importance?: number } = {
    canonicalKey: raw.canonicalKey,
    category: raw.category,
    headline: raw.headline,
    whyItMatters: raw.whyItMatters,
    caveat: raw.caveat,
    importance: raw.importance,
    sources: raw.sources,
  };
  // F4 + F1-null: only carry followUp through when it is a non-null object
  // whose priorDate AND priorFraming are both non-empty trimmed strings.
  // This handles followUp: null (from F1 schema) and partial/garbage objects
  // so "Previously (undefined)" never reaches the script prompt.
  if (
    raw.followUp != null &&
    typeof raw.followUp === "object" &&
    typeof raw.followUp.priorDate === "string" &&
    raw.followUp.priorDate.trim().length > 0 &&
    typeof raw.followUp.priorFraming === "string" &&
    raw.followUp.priorFraming.trim().length > 0
  ) {
    result.followUp = raw.followUp;
  }
  return result;
}

export async function curate(articles: Article[], date?: string): Promise<StoryCluster[]> {
  const started = Date.now();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  if (articles.length === 0) {
    logJson({ phase: "curate", status: "empty", durationMs: 0 });
    return [];
  }

  // Load prior coverage non-blockingly; empty list = cold run (no change in behaviour).
  const windowDays = 14;
  let priorCoverage: PriorCoverageEntry[] = [];
  if (date) {
    try {
      priorCoverage = await loadRecentCoverage(date, windowDays);
    } catch {
      // Non-blocking: if anything goes wrong just proceed cold.
      priorCoverage = [];
    }
  } else {
    // F12: emit a visible log when the ledger is bypassed due to missing date
    logJson({ phase: "curate.ledger", status: "skip", reason: "no date provided" });
  }

  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    timeout: TIMEOUT_MS,
  });

  const completion = await withRetry(
    () =>
      withHardTimeout(
        client.chat.completions.create({
          model: MODEL,
          messages: [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: buildUserPrompt(articles, priorCoverage, windowDays) },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "story_clusters",
              strict: true,
              schema: RESPONSE_SCHEMA,
            },
          },
          temperature: 0.3,
        }),
        TIMEOUT_MS,
        "curate.openrouter",
      ),
    { attempts: MAX_ATTEMPTS, label: "curate" },
  );

  const content = getChatCompletionAssistantText(completion, "OpenRouter curate");

  const parsed = JSON.parse(content) as {
    clusters: (StoryCluster & { importance: number; followUp?: { priorDate: string; priorFraming: string } | null })[];
  };

  // F5: guard against malformed/non-array clusters before mapping
  const normalisedClusters = (Array.isArray(parsed?.clusters) ? parsed.clusters : []).map(normaliseCluster);
  const clusters = selectStoryClusters(normalisedClusters);

  // Only emit threading tally when prior coverage was loaded (non-cold run).
  if (priorCoverage.length > 0) {
    const tally = computeThreadingTally(clusters, priorCoverage);
    logJson({
      phase: "curate.threading",
      status: "ok",
      newCount: tally.newCount,
      followUpCount: tally.followUpCount,
      priorKeysNotResurfacedCount: tally.priorKeysNotResurfacedCount,
      priorKeysNotResurfaced: tally.priorKeysNotResurfaced,
    });
  }

  logJson({
    phase: "curate",
    status: "ok",
    durationMs: Date.now() - started,
    inputArticles: articles.length,
    outputClusters: clusters.length,
    headlines: clusters.map((c) => c.headline),
    categories: clusters.map((c) => c.category),
  });

  return clusters;
}
