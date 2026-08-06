import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadAllRecords } from "./publish.js";
import type { EpisodeRecord } from "./publish.js";
import { isDateInWindow } from "./episode-date.js";
import type { CurationRecord } from "./types.js";

const DEFAULT_EPISODES_DIR = path.join("docs", "episodes");

/**
 * A prior-coverage entry: the CurationRecord from the sidecar plus the
 * date of the episode it came from.
 */
export interface PriorCoverageEntry extends CurationRecord {
  episodeDate: string;
}

/**
 * Loads curation records from episode sidecars whose date falls strictly
 * before `today` and within `windowDays` calendar days of `today`.
 *
 * Window: [today − windowDays, today) — today is excluded; prior coverage
 * only.
 *
 * Non-blocking: a missing directory, missing file, malformed JSON sidecar,
 * or record lacking a `curation` field is silently skipped. An empty result
 * ([]) is always a valid outcome.
 *
 * @param today     The reference date as YYYY-MM-DD (typically today's episode date).
 * @param windowDays Number of calendar days before today to include (default 14).
 * @param episodesDir Optional override for the episodes directory (default: docs/episodes).
 */
export async function loadRecentCoverage(
  today: string,
  windowDays = 14,
  episodesDir?: string,
): Promise<PriorCoverageEntry[]> {
  // F10: pass episodesDir directly (undefined → loadAllRecords uses its internal default)
  const records: EpisodeRecord[] = await loadAllRecords(episodesDir);

  const entries: PriorCoverageEntry[] = [];

  for (const record of records) {
    if (!isDateInWindow(record.date, today, windowDays)) continue;
    if (!Array.isArray(record.curation) || record.curation.length === 0) continue;
    for (const cr of record.curation) {
      entries.push({ ...cr, episodeDate: record.date });
    }
  }

  return entries;
}

/**
 * Style snippets from one prior episode's transcript, used to show the script
 * model its own recent prose so it stops reusing the same constructions.
 */
export interface RecentStyleSnippets {
  episodeDate: string;
  /** First sentence of the first intro paragraph. */
  introOpener: string;
  /** First sentence of the first paragraph after the Outro header. */
  outroOpener: string;
  /** Final narration paragraph of the episode. */
  signOff: string;
}

const TRANSCRIPT_FILENAME_PATTERN = /^(\d{4}-\d{2}-\d{2})\.transcript\.txt$/;
const MAX_SNIPPET_WORDS = 30;

/**
 * Loads intro-opener / outro-opener / sign-off snippets from the most recent
 * `count` transcripts strictly before `today`, newest first.
 *
 * Non-blocking, like loadRecentCoverage: a missing directory, unreadable file,
 * or transcript that doesn't match the buildTranscript layout is silently
 * skipped, and [] is always a valid outcome.
 */
export async function loadRecentStyleSnippets(
  today: string,
  count = 8,
  episodesDir?: string,
): Promise<RecentStyleSnippets[]> {
  const dir = episodesDir ?? DEFAULT_EPISODES_DIR;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  const dates: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = TRANSCRIPT_FILENAME_PATTERN.exec(entry.name);
    const date = match?.[1];
    if (!date || date >= today) continue;
    dates.push(date);
  }
  dates.sort().reverse();

  const snippets: RecentStyleSnippets[] = [];
  for (const date of dates) {
    if (snippets.length >= count) break;
    try {
      const text = await readFile(path.join(dir, `${date}.transcript.txt`), "utf8");
      const parsed = parseTranscriptStyleSnippets(date, text);
      if (parsed) snippets.push(parsed);
    } catch {
      // skip unreadable transcript
    }
  }
  return snippets;
}

/**
 * Parses a transcript produced by buildTranscript (src/publish.ts): title,
 * `Date:` line, `Intro` header, paragraphs (one narration chunk per line),
 * segment blocks with trailing `Source:` lines, then an `Outro` header and
 * closing paragraphs.
 */
export function parseTranscriptStyleSnippets(
  episodeDate: string,
  transcript: string,
): RecentStyleSnippets | undefined {
  const lines = transcript.split("\n").map((line) => line.trim());
  const introIndex = lines.indexOf("Intro");
  const outroIndex = lines.lastIndexOf("Outro");
  if (introIndex === -1 || outroIndex === -1 || outroIndex <= introIndex) return undefined;

  const firstParagraphAfter = (index: number): string | undefined => {
    for (let i = index + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line) return line;
    }
    return undefined;
  };

  const introParagraph = firstParagraphAfter(introIndex);
  const outroParagraph = firstParagraphAfter(outroIndex);

  let signOff: string | undefined;
  for (let i = lines.length - 1; i > outroIndex; i -= 1) {
    const line = lines[i];
    if (line && !line.startsWith("Source:")) {
      signOff = line;
      break;
    }
  }

  if (!introParagraph || !outroParagraph || !signOff) return undefined;

  return {
    episodeDate,
    introOpener: truncateWords(firstSentence(introParagraph)),
    outroOpener: truncateWords(firstSentence(outroParagraph)),
    signOff: truncateWords(signOff),
  };
}

function firstSentence(text: string): string {
  const match = /^.*?[.!?](?=\s|$)/.exec(text);
  return (match?.[0] ?? text).trim();
}

function truncateWords(text: string, maxWords = MAX_SNIPPET_WORDS): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ")}…`;
}
