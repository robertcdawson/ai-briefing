import type { Article } from "./types.js";

export const MAX_FEED_BYTES = 2 * 1024 * 1024;
export const MAX_ARTICLES_PER_FEED = 40;
export const MAX_ARTICLES = 200;
export const MAX_STORIES = 6;
export const MAX_CHUNKS_PER_PART = 24;
export const MAX_CHUNK_CHARS = 4000;
export const MAX_EPISODE_CHARS = 18000;
export const MAX_EPISODE_WORDS = 2400;
export const MAX_TTS_REQUESTS = 24;

/** Bound decoded bytes before RSS parsing, even without a Content-Length header. */
export async function readFeedText(response: Response, limit = MAX_FEED_BYTES): Promise<string> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("RSS response exceeds byte limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error("RSS response exceeds byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function boundedArticles(articles: readonly Article[]): Article[] {
  return articles.filter(a =>
    typeof a.title === "string" && a.title.length <= 300 &&
    typeof a.source === "string" && a.source.length <= 100 &&
    typeof a.url === "string" && a.url.length <= 2048 &&
    typeof a.excerpt === "string" && a.excerpt.length <= 900,
  ).slice(0, MAX_ARTICLES);
}

/** Applied to live model output AND cache results at the final speech boundary. */
export function assertNarrationBudget(episode: { intro: string[]; outro: string[]; segments: { chunks: string[] }[] }): void {
  if (!Array.isArray(episode.segments) || episode.segments.length > MAX_STORIES) {
    throw new Error("script exceeds segment budget");
  }
  let chars = 0;
  let words = 0;
  for (const chunks of [episode.intro, ...episode.segments.map(s => s.chunks), episode.outro]) {
    if (!Array.isArray(chunks) || chunks.length === 0) throw new Error("no narration chunks provided");
    if (chunks.length > MAX_CHUNKS_PER_PART) throw new Error("script exceeds chunk count budget");
    for (const chunk of chunks) {
      if (typeof chunk !== "string" || !chunk.trim()) throw new Error("narration chunk must be a non-empty string");
      if (chunk.length > MAX_CHUNK_CHARS) throw new Error("script exceeds chunk character budget");
      chars += chunk.length;
      words += chunk.trim().split(/\s+/).length;
    }
  }
  if (chars > MAX_EPISODE_CHARS || words > MAX_EPISODE_WORDS) throw new Error("script exceeds episode budget");
}
