import OpenAI from "openai";
import { STORY_CATEGORY_DEFINITIONS } from "./types.js";
import type { Article, StoryCluster } from "./types.js";
import { getChatCompletionAssistantText, logJson, withHardTimeout, withRetry } from "./util.js";

const MODEL = "anthropic/claude-sonnet-4.6";
const TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

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
        },
        required: [
          "canonicalKey",
          "category",
          "headline",
          "whyItMatters",
          "caveat",
          "importance",
          "sources",
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
4. SELECT the top 3 clusters by audience impact, preferring a diverse mix of categories when scores are close. If fewer than 3 credible stories exist, return fewer — never pad with weak material.

For each cluster:
- canonicalKey: short kebab-case slug
- category: one of the editorial lane ids above
- headline: 8-14 word neutral framing
- whyItMatters: 1-2 sentences on significance for AI builders/researchers
- caveat: 1 sentence on what's uncertain, missing, or potentially overhyped
- sources: every article in the cluster as {url, publisher}

Return only JSON matching the provided schema. No prose outside the JSON.`;
}

function buildUserPrompt(articles: Article[]): string {
  const lines = articles.map((a, i) => {
    const excerpt = a.excerpt.replace(/\s+/g, " ").trim();
    return `[${i + 1}] (${a.source}) ${a.title}\n    URL: ${a.url}\n    Excerpt: ${excerpt}`;
  });
  return `Articles from the last 24 hours (${articles.length} total):\n\n${lines.join("\n\n")}`;
}

export async function curate(articles: Article[]): Promise<StoryCluster[]> {
  const started = Date.now();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  if (articles.length === 0) {
    logJson({ phase: "curate", status: "empty", durationMs: 0 });
    return [];
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
            { role: "user", content: buildUserPrompt(articles) },
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
    clusters: (StoryCluster & { importance: number })[];
  };

  const clusters: StoryCluster[] = (parsed.clusters ?? [])
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 3)
    .map(({ importance: _importance, ...c }) => c);

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
