import { copyFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Feed } from "feed";
import { formatSpeakerTurns } from "./speakers.js";
import type { Episode, EpisodePartTiming } from "./types.js";
import { logJson } from "./util.js";

const DOCS_DIR = "docs";
const EPISODES_DIR = path.join(DOCS_DIR, "episodes");
const FEED_PATH = path.join(DOCS_DIR, "feed.xml");
const FEED_LIMIT = 30;
const RETENTION_DAYS = 90;
const PODCAST_GUID_NAMESPACE = "ead4c236-bf58-58c6-a2c6-a6b28d128cb6";

interface EpisodeRecord {
  date: string;
  title: string;
  description: string;
  durationSeconds: number;
  byteLength: number;
  pubDate: string;
  season?: number;
  episodeNumber?: number;
  chaptersFilename?: string;
  transcriptFilename?: string;
  chapters?: ChapterRecord[];
  soundbites?: SoundbiteRecord[];
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
  guid: string;
  locked: "yes" | "no";
  hostName: string;
}

interface ChapterRecord {
  startTime: number;
  title: string;
  endTime?: number;
}

interface SoundbiteRecord {
  startTime: number;
  duration: number;
  title: string;
}

interface FeedItemPodcastTags {
  durationSeconds: number;
  season: number;
  episodeNumber: number;
  chaptersUrl?: string;
  transcriptUrl?: string;
  soundbites: SoundbiteRecord[];
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
  partTimings: EpisodePartTiming[] = [],
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

  const description = buildEpisodeDescription(episode, durationSeconds, partTimings);
  const chapters = buildChapters(partTimings, durationSeconds);
  const soundbites = buildSoundbites(partTimings);
  const transcriptFilename = `${episode.date}.transcript.txt`;
  const chaptersFilename = chapters.length > 0 ? `${episode.date}.chapters.json` : undefined;
  const season = getSeasonNumber(episode.date);
  const episodeNumber = getEpisodeNumber(episode.date);

  await writeFile(
    path.join(EPISODES_DIR, transcriptFilename),
    buildTranscript(episode),
  );
  if (chaptersFilename) {
    await writeFile(
      path.join(EPISODES_DIR, chaptersFilename),
      JSON.stringify(
        {
          version: "1.2.0",
          title: episode.title,
          chapters,
        },
        null,
        2,
      ),
    );
  }

  const record: EpisodeRecord = {
    date: episode.date,
    title: episode.title,
    description,
    durationSeconds,
    byteLength,
    pubDate: new Date().toISOString(),
    season,
    episodeNumber,
    chaptersFilename,
    transcriptFilename,
    chapters,
    soundbites,
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
    items: Object.fromEntries(top.map((r) => {
      const guid = `ai-briefing-${r.date}`;
      const chaptersUrl = r.chaptersFilename
        ? `${trimmedBase}/episodes/${r.chaptersFilename}`
        : undefined;
      const transcriptUrl = r.transcriptFilename
        ? `${trimmedBase}/episodes/${r.transcriptFilename}`
        : undefined;
      return [
        guid,
        {
          durationSeconds: r.durationSeconds,
          season: r.season ?? getSeasonNumber(r.date),
          episodeNumber: r.episodeNumber ?? getEpisodeNumber(r.date),
          chaptersUrl,
          transcriptUrl,
          soundbites: r.soundbites ?? [],
        },
      ];
    })),
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
    const match = e.name.match(/^(\d{4}-\d{2}-\d{2})(?:\.mp3|\.json|\.chapters\.json|\.transcript\.txt)$/);
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
    if (!e.isFile() || !/^\d{4}-\d{2}-\d{2}\.json$/.test(e.name)) continue;
    const txt = await readFile(path.join(EPISODES_DIR, e.name), "utf8");
    try {
      records.push(JSON.parse(txt) as EpisodeRecord);
    } catch {
      // skip malformed sidecar
    }
  }
  return records;
}

function buildEpisodeDescription(
  ep: Episode,
  durationSeconds: number,
  partTimings: EpisodePartTiming[] = [],
): string {
  const chapterLines = buildChapters(partTimings, durationSeconds)
    .map((chapter) => `${formatTimestamp(chapter.startTime)} ${chapter.title}`);
  const sourceLines = ep.segments.flatMap((segment, index) => [
    `${index + 1}. ${segment.title}`,
    ...segment.sourceUrls.map((url) => `Source: ${url}`),
  ]);

  const lines = [
    `Top ${ep.segments.length} AI ${ep.segments.length === 1 ? "story" : "stories"} for ${ep.date}:`,
    "",
    ...(chapterLines.length > 0 ? ["Chapters:", ...chapterLines, ""] : []),
    "Sources:",
    ...sourceLines,
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
  opts: { metadata: PodcastMetadata; items: Record<string, FeedItemPodcastTags> },
): string {
  let out = rss.replace(/<rss\s+([^>]*?)>/, (_m, attrs: string) => {
    const namespaces = [attrs.trim()];
    if (!attrs.includes("xmlns:itunes")) {
      namespaces.push('xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"');
    }
    if (!attrs.includes("xmlns:podcast")) {
      namespaces.push('xmlns:podcast="https://podcastindex.org/namespace/1.0"');
    }
    return `<rss ${namespaces.join(" ")}>`;
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
    `        <itunes:type>${opts.metadata.type}</itunes:type>\n` +
    `        <podcast:guid>${opts.metadata.guid}</podcast:guid>\n` +
    `        <podcast:locked owner="${xmlEscape(opts.metadata.ownerEmail)}">${opts.metadata.locked}</podcast:locked>\n` +
    `        <podcast:person role="host" group="cast">${xmlEscape(opts.metadata.hostName)}</podcast:person>\n`;

  if (out.includes("<item>")) {
    out = out.replace("<item>", `${channelTags}        <item>`);
  } else {
    out = out.replace("</channel>", `${channelTags}    </channel>`);
  }

  for (const [guid, item] of Object.entries(opts.items)) {
    const guidPattern = new RegExp(
      `(<guid[^>]*>${escapeRegex(guid)}</guid>[\\s\\S]*?)</item>`,
    );
    const chaptersTag = item.chaptersUrl
      ? `            <podcast:chapters url="${xmlEscape(item.chaptersUrl)}" type="application/json+chapters"/>\n`
      : "";
    const transcriptTag = item.transcriptUrl
      ? `            <podcast:transcript url="${xmlEscape(item.transcriptUrl)}" type="text/plain" language="en"/>\n`
      : "";
    const soundbiteTags = item.soundbites
      .map((soundbite) =>
        `            <podcast:soundbite startTime="${formatSeconds(soundbite.startTime)}" duration="${formatSeconds(soundbite.duration)}">${xmlEscape(soundbite.title)}</podcast:soundbite>\n`
      )
      .join("");
    out = out.replace(
      guidPattern,
      `$1            <itunes:duration>${Math.max(0, Math.round(item.durationSeconds))}</itunes:duration>\n            <itunes:explicit>${opts.metadata.explicit}</itunes:explicit>\n            <itunes:season>${item.season}</itunes:season>\n            <itunes:episode>${item.episodeNumber}</itunes:episode>\n            <itunes:episodeType>full</itunes:episodeType>\n${chaptersTag}${transcriptTag}${soundbiteTags}        </item>`,
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
  const hostName = process.env.PODCAST_HOST_NAME?.trim() || author;
  const locked = parsePodcastLocked(process.env.PODCAST_LOCKED);
  const guid = generatePodcastGuid(`${trimmedBase}/feed.xml`);

  return {
    author,
    summary,
    ownerName,
    ownerEmail,
    imageHref,
    categories,
    explicit,
    type,
    guid,
    locked,
    hostName,
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

function parsePodcastLocked(raw: string | undefined): "yes" | "no" {
  return raw?.trim().toLowerCase() === "no" ? "no" : "yes";
}

function buildTranscript(ep: Episode): string {
  const lines = [
    ep.title,
    `Date: ${ep.date}`,
    "",
    "Intro",
    "",
    formatSpeakerTurns(ep.intro),
    "",
  ];

  for (const segment of ep.segments) {
    lines.push(segment.title, "", formatSpeakerTurns(segment.turns));
    for (const url of segment.sourceUrls) {
      lines.push(`Source: ${url}`);
    }
    lines.push("");
  }

  lines.push("Outro", "", formatSpeakerTurns(ep.outro), "");
  return lines.join("\n");
}

function buildChapters(
  partTimings: EpisodePartTiming[],
  durationSeconds: number,
): ChapterRecord[] {
  if (partTimings.length === 0) return [];
  return partTimings.map((part, index) => {
    const startTime = Math.max(0, Math.round(part.startTime));
    const next = partTimings[index + 1];
    const fallbackEnd = index === partTimings.length - 1
      ? durationSeconds
      : next?.startTime ?? part.startTime + part.durationSeconds;
    const endTime = Math.max(startTime, Math.round(fallbackEnd));
    return {
      startTime,
      endTime,
      title: formatChapterTitle(part),
    };
  });
}

function buildSoundbites(partTimings: EpisodePartTiming[]): SoundbiteRecord[] {
  return partTimings
    .filter((part) => part.kind === "segment")
    .map((part) => ({
      startTime: Math.max(0, Math.round(part.startTime)),
      duration: Math.max(1, Math.min(120, Math.round(part.durationSeconds))),
      title: formatChapterTitle(part),
    }));
}

function formatChapterTitle(part: EpisodePartTiming): string {
  if (part.kind === "intro") return "Intro";
  if (part.kind === "outro") return "Outro";
  const stripped = part.title.replace(/^[^:]{1,32}:\s+/, "").trim() || part.title.trim();
  return truncateForPodcastApp(stripped);
}

function truncateForPodcastApp(title: string): string {
  if (title.length <= 45) return title;
  const truncated = title.slice(0, 42).replace(/\s+\S*$/, "").trim();
  return `${truncated || title.slice(0, 42)}...`;
}

function getSeasonNumber(date: string): number {
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : 1;
}

function getEpisodeNumber(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return 1;
  const start = Date.UTC(year, 0, 1);
  const current = Date.UTC(year, month - 1, day);
  return Math.floor((current - start) / 86_400_000) + 1;
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function formatSeconds(seconds: number): string {
  return String(Math.max(0, Math.round(seconds)));
}

function generatePodcastGuid(feedUrl: string): string {
  const seed = feedUrl.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return uuidV5(seed, PODCAST_GUID_NAMESPACE);
}

function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = uuidToBytes(namespace);
  const hash = createHash("sha1")
    .update(Buffer.concat([namespaceBytes, Buffer.from(name, "utf8")]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  return Buffer.from(hex, "hex");
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
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
