import "dotenv/config";
import { resolveEpisodeDate } from "../src/episode-date.js";
import { pingHealthcheck } from "../src/healthcheck.js";
import { waitForEpisodeLive } from "../src/verifyDeploy.js";
import { logJson } from "../src/util.js";

/**
 * Verify today's episode is actually reachable in the published feed.
 *
 * Exit 0 = live, exit 1 = not live within the window. The workflow uses the
 * exit code to decide whether to retrigger the Pages deploy, so this must stay
 * a pure check with no side effects beyond monitoring pings.
 *
 * `--quiet` suppresses the failure ping, so the first (pre-retrigger) probe
 * does not page the operator for what the retry is about to fix.
 */
async function main(): Promise<void> {
  const quiet = process.argv.includes("--quiet");
  const baseUrl = process.env.FEED_BASE_URL?.trim();
  if (!baseUrl) throw new Error("FEED_BASE_URL is not set");

  const date = resolveEpisodeDate();
  const timeoutMs = Number(process.env.VERIFY_TIMEOUT_MS ?? "") || undefined;

  const live = await waitForEpisodeLive(baseUrl, date, { timeoutMs });

  if (live) {
    logJson({ phase: "verify", status: "ok", date });
    return;
  }

  logJson({
    phase: "verify",
    status: "error",
    date,
    error: "episode committed but not present in the published feed",
  });
  process.exitCode = 1;
  if (!quiet) await pingHealthcheck("fail");
}

main().catch((err) => {
  logJson({
    phase: "verify",
    status: "error",
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
