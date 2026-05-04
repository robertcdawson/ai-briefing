export interface FeedSource {
  name: string;
  url: string;
}

// Anthropic News: dropped 2026-05-04 — no public RSS feed advertised; every
// common path (/rss.xml, /feed.xml, /news/feed.xml, /atom.xml, etc.) returns 404.
// Semafor Technology: dropped 2026-05-04 — /api/rss/all/technology.xml returns 404.

export const SOURCES: FeedSource[] = [
  { name: "OpenAI Blog",        url: "https://openai.com/blog/rss.xml" },
  { name: "Google DeepMind",    url: "https://deepmind.google/blog/rss.xml" },
  { name: "Hugging Face",       url: "https://huggingface.co/blog/feed.xml" },
  { name: "The Verge AI",       url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { name: "Ars Technica AI",    url: "https://arstechnica.com/ai/feed/" },
  { name: "MIT Tech Review AI", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed/" },
  { name: "Stratechery",        url: "https://stratechery.com/feed/" },
  { name: "Simon Willison",     url: "https://simonwillison.net/atom/everything/" },
  { name: "Hacker News (AI)",   url: "https://hnrss.org/newest?q=AI+OR+LLM+OR+OpenAI+OR+Anthropic+OR+Claude+OR+GPT&points=100" },
  { name: "TechCrunch AI",      url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { name: "The Decoder",        url: "https://the-decoder.com/feed/" },
  { name: "404 Media",          url: "https://www.404media.co/rss/" },
];
