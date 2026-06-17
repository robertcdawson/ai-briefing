export const DEFAULT_EPISODE_TIME_ZONE = "America/Los_Angeles";

/**
 * Returns true if `candidate` (YYYY-MM-DD) falls strictly before `today` and
 * within `windowDays` days before `today`.
 *
 * Window: [today - windowDays, today)  — today itself is excluded.
 */
export function isDateInWindow(candidate: string, today: string, windowDays: number): boolean {
  // Compare as ISO date strings directly — lexicographic order equals chronological order
  // for YYYY-MM-DD strings.
  if (candidate >= today) return false;
  // Compute the earliest date in the window via UTC arithmetic.
  const todayMs = Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 1,
    Number(today.slice(8, 10)),
  );
  const cutoffMs = todayMs - windowDays * 86_400_000;
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
  return candidate >= cutoff;
}

export function resolveEpisodeDate(
  now = new Date(),
  timeZone = process.env.EPISODE_TIME_ZONE?.trim() || DEFAULT_EPISODE_TIME_ZONE,
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const year = getDatePart(parts, "year");
  const month = getDatePart(parts, "month");
  const day = getDatePart(parts, "day");
  return `${year}-${month}-${day}`;
}

function getDatePart(
  parts: Intl.DateTimeFormatPart[],
  type: "year" | "month" | "day",
): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value) throw new Error(`Unable to resolve episode date ${type}`);
  return value;
}
