import { copyFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Feed } from "feed";
import type { Episode } from "./types.js";
import { logJson } from "./util.js";

const DOCS_DIR = "docs";
const EPISODES_DIR = path.join(DOCS_DIR, "episodes");
const FEED_PATH = path.join(DOCS_DIR, "feed.xml");
const FEED_LIMIT = 30;
const RETENTION_DAYS = 90;

interface EpisodeRecord {
  date: string;
  title: string;
  description: string;
  durationSeconds: number;
  byteLength: number;
  pubDate: string;
}

interface PodcastMetadata {
  author: string;
  summary: string;
  ownerName: string;
  ownerEmail: string;
  imageHref: string;
  categories: string[];
  explicit: "true" | "false";
  type: "episodic" | "serial";
}

export interface PublishResult {
  episodePath: string;
  feedPath: string;
  feedItemCount: number;
}

export async function publish(
  episode: Episode,
  audioPath: string,
  byteLength: number,
  durationSeconds: number,
): Promise<PublishResult> {
  const started = Date.now();
  const baseUrl = process.env.FEED_BASE_URL;
  if (!baseUrl) throw new Error("FEED_BASE_URL is not set");
  const trimmedBase = stripTrailingSlash(baseUrl);
  const metadata = getPodcastMetadata(trimmedBase);

  await mkdir(EPISODES_DIR, { recursive: true });

  const targetFilename = `${episode.date}.mp3`;
  const episodePath = path.join(EPISODES_DIR, targetFilename);
  await copyFile(audioPath, episodePath);

  const description = buildEpisodeDescription(episode);
  const record: EpisodeRecord = {
    date: episode.date,
    title: episode.title,
    description,
    durationSeconds,
    byteLength,
    pubDate: new Date().toISOString(),
  };
  await writeFile(
    path.join(EPISODES_DIR, `${episode.date}.json`),
    JSON.stringify(record, null, 2),
  );

  const all = await loadAllRecords();
  const sorted = all.sort((a, b) => b.date.localeCompare(a.date));
  const top = sorted.slice(0, FEED_LIMIT);

  const feed = new Feed({
    title: "AI Briefing",
    description: "Daily AI news briefing — the top three stories from the last 24 hours.",
    id: trimmedBase + "/",
    link: trimmedBase + "/",
    language: "en",
    feedLinks: { rss: trimmedBase + "/feed.xml" },
    author: { name: "AI Briefing" },
    copyright: `© ${new Date().getUTCFullYear()} AI Briefing`,
    updated: new Date(),
  });

  for (const r of top) {
    const enclosureUrl = `${trimmedBase}/episodes/${r.date}.mp3`;
    feed.addItem({
      title: r.title,
      id: `ai-briefing-${r.date}`,
      link: enclosureUrl,
      date: new Date(r.pubDate),
      description: r.description,
      enclosure: {
        url: enclosureUrl,
        length: r.byteLength,
        type: "audio/mpeg",
      },
    });
  }

  const baseRss = feed.rss2();
  const finalXml = injectItunesTags(baseRss, {
    metadata,
    items: Object.fromEntries(top.map((r) => [`ai-briefing-${r.date}`, r.durationSeconds])),
  });

  await writeFile(FEED_PATH, finalXml);

  const keepDates = new Set(top.map((r) => r.date));
  const pruned = await pruneOldEpisodes(keepDates);

  logJson({
    phase: "publish",
    status: "ok",
    durationMs: Date.now() - started,
    episodePath,
    feedItemCount: top.length,
    feedBytes: finalXml.length,
    pruned: pruned.length,
    prunedFiles: pruned,
  });

  return { episodePath, feedPath: FEED_PATH, feedItemCount: top.length };
}

// Delete episode files older than RETENTION_DAYS, except any whose date is still
// listed in feed.xml — we never strand a feed entry pointing at a deleted file.
async function pruneOldEpisodes(keepDates: Set<string>): Promise<string[]> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const entries = await readdir(EPISODES_DIR, { withFileTypes: true }).catch(() => []);
  const pruned: string[] = [];

  for (const e of entries) {
    if (!e.isFile()) continue;
    const match = e.name.match(/^(\d{4}-\d{2}-\d{2})\.(mp3|json)$/);
    if (!match) continue;
    const episodeDate = match[1]!;
    if (keepDates.has(episodeDate)) continue;
    if (episodeDate >= cutoffStr) continue;
    const fullPath = path.join(EPISODES_DIR, e.name);
    try {
      await unlink(fullPath);
      pruned.push(e.name);
    } catch (err) {
      logJson({
        phase: "publish.prune",
        status: "warn",
        file: e.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return pruned;
}

async function loadAllRecords(): Promise<EpisodeRecord[]> {
  const entries = await readdir(EPISODES_DIR, { withFileTypes: true }).catch(() => []);
  const records: EpisodeRecord[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const txt = await readFile(path.join(EPISODES_DIR, e.name), "utf8");
    try {
      records.push(JSON.parse(txt) as EpisodeRecord);
    } catch {
      // skip malformed sidecar
    }
  }
  return records;
}

function buildEpisodeDescription(ep: Episode): string {
  const lines = [
    `Top ${ep.segments.length} AI ${ep.segments.length === 1 ? "story" : "stories"} for ${ep.date}:`,
    "",
    ...ep.segments.map((s, i) => `${i + 1}. ${s.title}`),
  ];
  return lines.join("\n");
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

// The `feed` package emits clean RSS 2.0 but no iTunes namespace. Patch it
// deterministically: add the namespace, then inject channel + item iTunes tags.
function injectItunesTags(
  rss: string,
  opts: { metadata: PodcastMetadata; items: Record<string, number> },
): string {
  let out = rss.replace(/<rss\s+([^>]*?)>/, (_m, attrs: string) => {
    if (attrs.includes("xmlns:itunes")) return `<rss ${attrs}>`;
    return `<rss ${attrs.trim()} xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">`;
  });

  const categoryTags = opts.metadata.categories
    .map((category) => `        <itunes:category text="${xmlEscape(category)}"/>\n`)
    .join("");

  const channelTags =
    `        <itunes:author>${xmlEscape(opts.metadata.author)}</itunes:author>\n` +
    `        <itunes:summary>${xmlEscape(opts.metadata.summary)}</itunes:summary>\n` +
    `        <itunes:owner>\n` +
    `            <itunes:name>${xmlEscape(opts.metadata.ownerName)}</itunes:name>\n` +
    `            <itunes:email>${xmlEscape(opts.metadata.ownerEmail)}</itunes:email>\n` +
    `        </itunes:owner>\n` +
    `        <itunes:image href="${xmlEscape(opts.metadata.imageHref)}"/>\n` +
    categoryTags +
    `        <itunes:explicit>${opts.metadata.explicit}</itunes:explicit>\n` +
    `        <itunes:type>${opts.metadata.type}</itunes:type>\n`;

  if (out.includes("<item>")) {
    out = out.replace("<item>", `${channelTags}        <item>`);
  } else {
    out = out.replace("</channel>", `${channelTags}    </channel>`);
  }

  for (const [guid, durationSec] of Object.entries(opts.items)) {
    const guidPattern = new RegExp(
      `(<guid[^>]*>${escapeRegex(guid)}</guid>[\\s\\S]*?)</item>`,
    );
    out = out.replace(
      guidPattern,
      `$1            <itunes:duration>${Math.max(0, Math.round(durationSec))}</itunes:duration>\n            <itunes:explicit>${opts.metadata.explicit}</itunes:explicit>\n            <itunes:episodeType>full</itunes:episodeType>\n        </item>`,
    );
  }

  return out;
}

function getPodcastMetadata(trimmedBase: string): PodcastMetadata {
  const author = process.env.PODCAST_AUTHOR?.trim() || "AI Briefing";
  const summary =
    process.env.PODCAST_SUMMARY?.trim()
    || "Daily AI news briefing — top three stories from the last 24 hours, fully scripted.";
  const ownerName = process.env.PODCAST_OWNER_NAME?.trim() || author;
  const ownerEmail = process.env.PODCAST_OWNER_EMAIL?.trim() || "noreply@example.com";
  const imageHref =
    process.env.PODCAST_IMAGE_URL?.trim() || `${trimmedBase}/podcast-cover.jpg`;
  const categories = parseCategoryList(process.env.PODCAST_CATEGORIES);
  const explicit = parseExplicitFlag(process.env.PODCAST_EXPLICIT);
  const type = parsePodcastType(process.env.PODCAST_TYPE);

  return {
    author,
    summary,
    ownerName,
    ownerEmail,
    imageHref,
    categories,
    explicit,
    type,
  };
}

function parseCategoryList(raw: string | undefined): string[] {
  if (!raw) return ["Technology"];
  const items = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return items.length > 0 ? items : ["Technology"];
}

function parseExplicitFlag(raw: string | undefined): "true" | "false" {
  return raw?.trim().toLowerCase() === "true" ? "true" : "false";
}

function parsePodcastType(raw: string | undefined): "episodic" | "serial" {
  return raw?.trim().toLowerCase() === "serial" ? "serial" : "episodic";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "'": return "&apos;";
      case '"': return "&quot;";
      default: return c;
    }
  });
}
