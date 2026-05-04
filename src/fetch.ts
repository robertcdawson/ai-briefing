import Parser from "rss-parser";
import { SOURCES, type FeedSource } from "./feeds.js";
import type { Article } from "./types.js";
import { logJson, withHardTimeout, withRetry } from "./util.js";

const PER_FEED_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const FRESHNESS_MS = 24 * 60 * 60 * 1000;

const parser = new Parser({ timeout: PER_FEED_TIMEOUT_MS });

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchSource(source: FeedSource): Promise<Article[]> {
  const res = await fetch(source.url, {
    signal: AbortSignal.timeout(PER_FEED_TIMEOUT_MS),
    headers: { "user-agent": "ai-briefing/0.1 (+rss aggregator)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const xml = await res.text();

  const feed = await withHardTimeout(
    parser.parseString(xml),
    PER_FEED_TIMEOUT_MS,
    `parse ${source.name}`,
  );

  const cutoff = Date.now() - FRESHNESS_MS;
  const articles: Article[] = [];
  for (const item of feed.items ?? []) {
    const dateStr = item.isoDate ?? item.pubDate;
    const url = item.link;
    const title = item.title;
    if (!dateStr || !url || !title) continue;
    const ts = Date.parse(dateStr);
    if (Number.isNaN(ts) || ts < cutoff) continue;
    const rawExcerpt = item.contentSnippet?.trim() || stripHtml(item.content ?? "");
    articles.push({
      title: title.trim(),
      source: source.name,
      url,
      publishedAt: new Date(ts).toISOString(),
      excerpt: rawExcerpt.slice(0, 500),
    });
  }
  return articles;
}

export async function fetchAll(): Promise<Article[]> {
  const started = Date.now();
  const settled = await Promise.allSettled(
    SOURCES.map((s) =>
      withHardTimeout(
        withRetry(() => fetchSource(s), { attempts: MAX_ATTEMPTS, label: s.name }),
        PER_FEED_TIMEOUT_MS * MAX_ATTEMPTS + 5_000,
        s.name,
      ),
    ),
  );

  const articles: Article[] = [];
  for (let i = 0; i < SOURCES.length; i++) {
    const source = SOURCES[i]!;
    const result = settled[i]!;
    if (result.status === "fulfilled") {
      logJson({
        phase: "fetch",
        source: source.name,
        status: "ok",
        count: result.value.length,
      });
      articles.push(...result.value);
    } else {
      logJson({
        phase: "fetch",
        source: source.name,
        status: "skipped",
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  logJson({
    phase: "fetch",
    status: "ok",
    durationMs: Date.now() - started,
    sources: SOURCES.length,
    sourcesOk: settled.filter((s) => s.status === "fulfilled").length,
    totalArticles: articles.length,
  });

  return articles;
}
