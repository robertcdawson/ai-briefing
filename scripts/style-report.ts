import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { extractNarrationText } from "../src/ledger.js";
import { computeStyleReport } from "../src/styleMetrics.js";
import type { EpisodeText } from "../src/styleMetrics.js";

const TRANSCRIPT_FILENAME_PATTERN = /^(\d{4}-\d{2}-\d{2})\.transcript\.txt$/;
const MAX_EPISODES = 15;
const MAX_GRAMS_PRINTED = 20;

/**
 * Read-only style-drift report: per-episode sentence shape and rhetorical-
 * device counts, plus cross-episode repeated 3/4-grams. Prints to stdout and
 * always exits 0 — this is a diagnostic tool, not a pipeline gate.
 *
 * Usage: npm run style:report [episodesDir]
 */
async function main(): Promise<void> {
  const dir = process.argv[2] ?? path.join("docs", "episodes");

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.log(`style-report: could not read "${dir}": ${describeError(err)}`);
    return;
  }

  const dates: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = TRANSCRIPT_FILENAME_PATTERN.exec(entry.name);
    if (match?.[1]) dates.push(match[1]);
  }
  dates.sort().reverse();
  const recentDates = dates.slice(0, MAX_EPISODES);

  const episodes: EpisodeText[] = [];
  for (const date of recentDates) {
    try {
      const raw = await readFile(path.join(dir, `${date}.transcript.txt`), "utf8");
      episodes.push({ episodeDate: date, narrationText: extractNarrationText(raw) });
    } catch {
      // skip unreadable transcript — this is a report, not a gate
    }
  }
  episodes.reverse(); // oldest first, so the table reads chronologically

  if (episodes.length === 0) {
    console.log(`style-report: no readable transcripts found in "${dir}"`);
    return;
  }

  const report = computeStyleReport(episodes);

  console.log(`Style report — ${episodes.length} episode(s) from ${dir}\n`);
  printTable(
    ["Date", "Words", "Sent.", "MeanW", "VarW", "Antith", "Triad", "Meta"],
    report.episodes.map((m) => [
      m.episodeDate,
      String(m.wordCount),
      String(m.sentenceCount),
      m.meanSentenceWords.toFixed(1),
      m.sentenceWordVariance.toFixed(1),
      String(m.antithesisCount),
      String(m.triadCount),
      String(m.metadiscourseCount),
    ]),
  );

  console.log(`\nTop repeated 3/4-grams (>= 3 of last ${episodes.length} episode(s)):\n`);
  if (report.repeatedGrams.length === 0) {
    console.log("  (none)");
  } else {
    for (const gram of report.repeatedGrams.slice(0, MAX_GRAMS_PRINTED)) {
      console.log(`  "${gram.gram}" — ${gram.episodeCount} episodes (${gram.dates.join(", ")})`);
    }
  }
}

function printTable(header: readonly string[], rows: readonly string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]?.length ?? 0)));
  const formatRow = (cells: readonly string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ");
  console.log(formatRow(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(formatRow(row));
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
  // A style report failing outright is still a report finding, not a
  // pipeline failure — log and exit 0 rather than propagate.
  console.error(`style-report: unexpected error: ${describeError(err)}`);
});
