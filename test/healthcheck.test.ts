import test from "node:test";
import assert from "node:assert/strict";
import { buildHealthcheckUrl, resolveHealthcheckUrl, pingHealthcheck } from "../src/healthcheck.js";

test("buildHealthcheckUrl composes start/success/fail correctly", () => {
  const base = "https://hc-ping.com/abc";
  assert.equal(buildHealthcheckUrl(base, "start"), "https://hc-ping.com/abc/start");
  assert.equal(buildHealthcheckUrl(base, "success"), "https://hc-ping.com/abc");
  assert.equal(buildHealthcheckUrl(base, "fail"), "https://hc-ping.com/abc/fail");
});

test("buildHealthcheckUrl tolerates a trailing slash on the base", () => {
  const base = "https://hc-ping.com/abc/";
  assert.equal(buildHealthcheckUrl(base, "start"), "https://hc-ping.com/abc/start");
  assert.equal(buildHealthcheckUrl(base, "success"), "https://hc-ping.com/abc");
});

test("resolveHealthcheckUrl returns undefined when unset or blank", () => {
  assert.equal(resolveHealthcheckUrl({}), undefined);
  assert.equal(resolveHealthcheckUrl({ HEALTHCHECK_URL: "   " }), undefined);
});

test("resolveHealthcheckUrl returns the trimmed value when set", () => {
  assert.equal(resolveHealthcheckUrl({ HEALTHCHECK_URL: "  https://hc-ping.com/x  " }), "https://hc-ping.com/x");
});

test("pingHealthcheck is a no-op when monitoring is unconfigured", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response(null);
  }) as unknown as typeof fetch;

  // Force monitoring off with an explicit empty string, so the test stays
  // hermetic even if HEALTHCHECK_URL is set in the environment (e.g. in CI).
  await pingHealthcheck("start", { url: "", fetchImpl });
  assert.equal(called, false, "fetch must not be called when no URL is configured");
});

test("pingHealthcheck swallows a non-2xx response without throwing", async () => {
  const fetchImpl = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  await assert.doesNotReject(() =>
    pingHealthcheck("success", { url: "https://hc-ping.com/x", fetchImpl }),
  );
});

test("pingHealthcheck calls the composed URL for each kind", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return new Response(null);
  }) as unknown as typeof fetch;

  await pingHealthcheck("start", { url: "https://hc-ping.com/x", fetchImpl });
  await pingHealthcheck("success", { url: "https://hc-ping.com/x", fetchImpl });
  await pingHealthcheck("fail", { url: "https://hc-ping.com/x", fetchImpl });

  assert.deepEqual(calls, [
    "https://hc-ping.com/x/start",
    "https://hc-ping.com/x",
    "https://hc-ping.com/x/fail",
  ]);
});

test("pingHealthcheck swallows a throwing fetch without throwing", async () => {
  const fetchImpl = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;

  await assert.doesNotReject(() =>
    pingHealthcheck("success", { url: "https://hc-ping.com/x", fetchImpl }),
  );
});
