export const DEFAULT_EPISODE_TIME_ZONE = "America/Los_Angeles";

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
