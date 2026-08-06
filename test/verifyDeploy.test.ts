import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFeedUrl,
  episodeGuid,
  feedContainsEpisode,
  fetchLiveFeed,
  waitForEpisodeLive,
} from "../src/verifyDeploy.js";

const DATE = "2026-08-06";

function feedWith(dates: string[]): string {
  const items = dates
    .map((d) => `<item><guid>${episodeGuid(d)}</guid><title>AI Briefing</title></item>`)
    .join("");
  return `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
}

function okResponse(body: string): Response {
  return { ok: true, status: 200, text: async () => body } as unknown as Response;
}

test("feedContainsEpisode detects the episode guid", () => {
  assert.equal(feedContainsEpisode(feedWith([DATE]), DATE), true);
  assert.equal(feedContainsEpisode(feedWith(["2026-08-05"]), DATE), false);
  assert.equal(feedContainsEpisode("", DATE), false);
});

test("feedContainsEpisode tolerates guid attributes and whitespace", () => {
  const xml = `<item><guid isPermaLink="false"> ${episodeGuid(DATE)} </guid></item>`;
  assert.equal(feedContainsEpisode(xml, DATE), true);
});

test("feedContainsEpisode does not match a date as a prefix of another", () => {
  // Guards against a substring check treating 2026-08-0 as a match for 2026-08-06.
  const xml = `<item><guid>${episodeGuid("2026-08-061")}</guid></item>`;
  assert.equal(feedContainsEpisode(xml, DATE), false);
});

test("buildFeedUrl normalizes the base and cache-busts", () => {
  assert.equal(buildFeedUrl("https://example.com/site///"), "https://example.com/site/feed.xml");
  assert.equal(buildFeedUrl("https://example.com", 42), "https://example.com/feed.xml?cb=42");
});

test("fetchLiveFeed returns undefined on a non-2xx response", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 }) as unknown as Response;
  assert.equal(await fetchLiveFeed("https://example.com", { fetchImpl }), undefined);
});

test("fetchLiveFeed returns undefined when the request throws", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNRESET");
  };
  assert.equal(await fetchLiveFeed("https://example.com", { fetchImpl }), undefined);
});

test("waitForEpisodeLive succeeds on the first poll when the episode is live", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return okResponse(feedWith([DATE]));
  };

  const live = await waitForEpisodeLive("https://example.com", DATE, {
    fetchImpl,
    sleep: async () => {},
  });

  assert.equal(live, true);
  assert.equal(calls, 1);
});

test("waitForEpisodeLive keeps polling past transient failures and a stale feed", async () => {
  // Stale feed (yesterday only), then a transport error, then the deploy lands.
  const responses: Array<() => Promise<Response>> = [
    async () => okResponse(feedWith(["2026-08-05"])),
    async () => {
      throw new Error("ETIMEDOUT");
    },
    async () => okResponse(feedWith(["2026-08-05", DATE])),
  ];
  let calls = 0;
  const fetchImpl = async () => responses[calls++]!();

  let clock = 0;
  const live = await waitForEpisodeLive("https://example.com", DATE, {
    fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });

  assert.equal(live, true);
  assert.equal(calls, 3);
});

test("waitForEpisodeLive gives up once the window expires", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return okResponse(feedWith(["2026-08-05"]));
  };

  let clock = 0;
  const live = await waitForEpisodeLive("https://example.com", DATE, {
    fetchImpl,
    timeoutMs: 60_000,
    intervalMs: 20_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });

  assert.equal(live, false);
  // Polls at 0/20s/40s/60s, then the deadline check ends it.
  assert.equal(calls, 4);
});
