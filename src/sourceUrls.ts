/** Source links are data from RSS/models, even when loaded from a stage cache. */
export function isSafeSourceUrl(value: unknown): value is string {
  // Check controls BEFORE trimming: URL() silently strips some of them.
  // Ordinary surrounding spaces are allowed, as in script source equality.
  if (typeof value !== "string" || /[\u0000-\u001f\u007f\\]/.test(value)) {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.includes(" ") || !/^https?:\/\/[^/]/i.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}
