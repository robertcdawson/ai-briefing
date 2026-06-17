import { loadAllRecords } from "./publish.js";
import type { EpisodeRecord } from "./publish.js";
import { isDateInWindow } from "./episode-date.js";
import type { CurationRecord } from "./types.js";

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
