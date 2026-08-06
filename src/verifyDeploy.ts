import { logJson } from "./util.js";

/**
 * Publish verification (the gap that dropped the 2026-08-06 episode).
 *
 * The pipeline commits and pushes docs/, but what listeners actually read is the
 * GitHub Pages *deployment* of that commit. Those are separate systems: on
 * 2026-08-06 the commit landed and the Pages deploy sat in `deployment_queued`
 * until the action timed out and cancelled it, so the episode existed in the
 * repo but never reached Apple Podcasts. Nothing in the run failed, so the
 * healthcheck reported a green day.
 *
 * This module closes that loop by asking the only question that matters: is
 * today's episode in the feed at the public URL? Everything else — commit,
 * push, build — is an implementation detail on the way there.
 */

const DEFAULT_POLL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 20_000;
const FETCH_TIMEOUT_MS = 20_000;

export function episodeGuid(date: string): string {
  return `ai-briefing-${date}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when the feed XML carries an <item> for `date`. Tolerates attributes on
 * the guid element (e.g. isPermaLink) so a feed-library change can't silently
 * turn this check into a permanent false negative.
 */
export function feedContainsEpisode(xml: string, date: string): boolean {
  const pattern = new RegExp(`<guid[^>]*>\\s*${escapeRegex(episodeGuid(date))}\\s*</guid>`);
  return pattern.test(xml);
}

export function buildFeedUrl(baseUrl: string, cacheBuster?: string | number): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const url = `${trimmed}/feed.xml`;
  return cacheBuster === undefined ? url : `${url}?cb=${cacheBuster}`;
}

export interface FetchFeedOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cacheBuster?: string | number;
}

/**
 * Fetch the live feed. Returns undefined on any transport/HTTP failure — a
 * single failed poll is not evidence the episode is missing, so callers keep
 * polling rather than treating it as a verdict.
 */
export async function fetchLiveFeed(
  baseUrl: string,
  opts: FetchFeedOptions = {},
): Promise<string | undefined> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);

  try {
    // Pages sits behind a CDN; without cache-busting we can poll a stale copy
    // for the whole window and wrongly conclude the deploy failed.
    const res = await fetchImpl(buildFeedUrl(baseUrl, opts.cacheBuster ?? Date.now()), {
      method: "GET",
      headers: { "cache-control": "no-cache", pragma: "no-cache" },
      signal: controller.signal,
    });
    if (!res.ok) {
      logJson({ phase: "verify.fetch", status: "warn", error: `HTTP ${res.status}` });
      return undefined;
    }
    return await res.text();
  } catch (err) {
    logJson({
      phase: "verify.fetch",
      status: "warn",
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export interface WaitOptions extends FetchFeedOptions {
  timeoutMs?: number;
  intervalMs?: number;
  fetchTimeoutMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Poll the live feed until `date` appears or the window expires.
 *
 * A Pages deploy normally completes in 2-3 minutes; the default 10-minute
 * window covers a slow-but-healthy deploy without masking a genuinely stuck
 * one (the failure mode we are trying to surface).
 */
export async function waitForEpisodeLive(
  baseUrl: string,
  date: string,
  opts: WaitOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const deadline = now() + timeoutMs;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const xml = await fetchLiveFeed(baseUrl, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.fetchTimeoutMs,
      cacheBuster: `${now()}-${attempt}`,
    });

    if (xml && feedContainsEpisode(xml, date)) {
      logJson({ phase: "verify", status: "live", date, attempt });
      return true;
    }

    if (now() >= deadline) {
      logJson({ phase: "verify", status: "not_live", date, attempts: attempt });
      return false;
    }

    logJson({ phase: "verify", status: "pending", date, attempt });
    await sleep(intervalMs);
  }
}
