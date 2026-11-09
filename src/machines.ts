/**
 * Named transitions for the run states that used to be independent flags.
 *
 * A straight-line stage (fetch, then curate, then script) stays a procedure
 * in `src/index.ts`. What lives here is every decision whose states can be
 * combined into a lie: a green healthcheck while the feed is dark, a
 * "disabled" interest profile that is really the default, a cue style that
 * claims `asset` after the files were missing, a script model that both
 * accepted and fell through.
 *
 * Feed liveness is a second actor. The verifier must not see the deploy key,
 * so the retrigger stays in `.github/workflows/daily.yml`. `nextPagesRecoveryStep`
 * is the legal next step that workflow is pinned to.
 *
 * Left as procedures on purpose, because their states are already exclusive:
 * - per-attempt retry (`withRetry`)
 * - stage cache hit / store / warn (`withStageCache`) — a cache miss computes
 * - ear edit keep-or-use (`EarEditResult.edited`) — failure keeps the script
 * - TTS provider selection (`resolveTTSProviderConfig`) — one config object
 * - fetch per source — one feed can fail; the run fails only at zero articles
 * - retention — a date window, not a status field on the episode
 * - story suppression — the curator omits a cluster; absence is not proof it
 *   was suppressed rather than missing from today's feeds. Aired stories are
 *   only `new` or `follow_up` (`airedStoryDisposition`). Held stories in the
 *   curation report are `below_threshold` or `over_cap`.
 */

export type GenerationOutcome =
  | { status: "skipped"; reason: "episode_already_published" }
  | { status: "published" }
  | { status: "failed" };

/**
 * The generation job's healthcheck signal.
 * Skipped and published are both a successful job: files are on disk, or
 * today's episode was already there. Listeners hearing it is feed liveness,
 * which pings `fail` from the loud verifier only.
 */
export function healthcheckKindForGeneration(outcome: GenerationOutcome): "success" | "fail" {
  switch (outcome.status) {
    case "skipped":
    case "published":
      return "success";
    case "failed":
      return "fail";
  }
}

export type FeedPoll =
  | { status: "pending"; attempt: number }
  | { status: "live"; attempt: number }
  | { status: "not_live"; attempts: number };

/** One poll of the public feed. A transport failure is `sawEpisode: false`. */
export function nextFeedPoll(input: {
  attempt: number;
  sawEpisode: boolean;
  pastDeadline: boolean;
}): FeedPoll {
  if (input.sawEpisode) return { status: "live", attempt: input.attempt };
  if (input.pastDeadline) return { status: "not_live", attempts: input.attempt };
  return { status: "pending", attempt: input.attempt };
}

/**
 * The first probe is quiet so a miss the retrigger is about to fix does not
 * page. A live feed never pings from the verifier; generation already did.
 */
export function healthcheckKindForVerification(live: boolean, quiet: boolean): "fail" | "none" {
  if (live || quiet) return "none";
  return "fail";
}

export const PAGES_RECOVERY_STEP_NAMES = [
  "Verify published feed",
  "Retrigger Pages deployment",
  "Verify retriggered feed",
] as const;

export function nextPagesRecoveryStep(
  step: "verify_quiet" | "verify_loud",
  live: boolean,
): "done" | "retrigger_push" | "failed" {
  if (live) return "done";
  return step === "verify_quiet" ? "retrigger_push" : "failed";
}

/** Logged generation steps, in the only legal order. Ear edit may be skipped. */
export const GENERATION_STEP_ORDER = [
  "fetch",
  "curate",
  "script",
  "earEdit",
  "tts",
  "audio",
  "publish",
] as const;

export type InterestProfileMode =
  | { mode: "default"; text: string }
  | { mode: "custom"; text: string }
  | { mode: "disabled" };

/**
 * `undefined` is the committed default. Blank text is an explicit disable.
 * GitHub Actions cannot tell unset from empty, so `daily.yml` unsets a
 * sentinel before this runs. Whitespace in Actions is the disable signal.
 */
export function resolveInterestProfileMode(
  override: string | undefined,
  fallback: string,
): InterestProfileMode {
  if (override === undefined) return { mode: "default", text: fallback.trim() };
  const text = override.trim();
  if (text.length === 0) return { mode: "disabled" };
  return { mode: "custom", text };
}

export function interestProfileText(mode: InterestProfileMode): string {
  return mode.mode === "disabled" ? "" : mode.text;
}

export type RequestedCueStyle = "tone" | "chime" | "tick" | "asset";
export type ResolvedCueStyle = Exclude<RequestedCueStyle, "asset"> | "asset";

/** `asset` with no files is `tone`. Other styles ignore the asset flag. */
export function cueStyleAfterAssetLookup(
  requested: RequestedCueStyle,
  assetsReady: boolean,
): ResolvedCueStyle {
  if (requested === "asset") return assetsReady ? "asset" : "tone";
  return requested;
}

export type ScriptModelStep =
  | { step: "accept"; model: string }
  | { step: "fallback"; model: string; nextModel: string }
  | { step: "exhaust"; model: string };

export function scriptModelStep(
  model: string,
  nextModel: string | undefined,
  accepted: boolean,
): ScriptModelStep {
  if (accepted) return { step: "accept", model };
  if (nextModel) return { step: "fallback", model, nextModel };
  return { step: "exhaust", model };
}

/** Aired stories are new or a follow-up. Omission is not a third stored state. */
export type AiredStoryDisposition = "new" | "follow_up";

export function airedStoryDisposition(hasFollowUp: boolean): AiredStoryDisposition {
  return hasFollowUp ? "follow_up" : "new";
}

export type TtsPartPlan = "whole" | "chunked";

/** One request for the whole part until the provider character cap. */
export function ttsPartPlan(inputChars: number, maxChars: number): TtsPartPlan {
  return inputChars <= maxChars ? "whole" : "chunked";
}

export type ShowConfigOutcome =
  | { status: "loaded" }
  | { status: "fallback"; reason: "missing" | "unreadable" | "invalid" };

export function showConfigReadOutcome(
  kind: "ok" | "enoent" | "unreadable" | "invalid",
): ShowConfigOutcome {
  switch (kind) {
    case "ok":
      return { status: "loaded" };
    case "enoent":
      return { status: "fallback", reason: "missing" };
    case "unreadable":
      return { status: "fallback", reason: "unreadable" };
    case "invalid":
      return { status: "fallback", reason: "invalid" };
  }
}
