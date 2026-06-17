import { logJson } from "./util.js";

/**
 * Dead-man's-switch monitoring (M7).
 *
 * Pings a Healthchecks.io-style endpoint at the start of a run, on success, and
 * on failure, so a missed or failed unattended run alerts the operator. A run
 * that never starts is caught by the monitor's own expected-period config — no
 * code needed for that case.
 *
 * Configured via the HEALTHCHECK_URL env var (the check's base ping URL). Unset
 * or blank disables monitoring entirely. Pinging is strictly fail-safe: a ping
 * error (network, timeout, bad URL) must NEVER affect or fail the pipeline.
 */

export type HealthcheckKind = "start" | "success" | "fail";

const PING_TIMEOUT_MS = 5_000;

/** The configured base ping URL, or undefined when monitoring is disabled. */
export function resolveHealthcheckUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.HEALTHCHECK_URL?.trim();
  return raw ? raw : undefined;
}

/**
 * Healthchecks.io URL convention: the bare base signals success, `<base>/start`
 * signals a run beginning, `<base>/fail` signals failure.
 */
export function buildHealthcheckUrl(base: string, kind: HealthcheckKind): string {
  const trimmed = base.replace(/\/+$/, "");
  return kind === "success" ? trimmed : `${trimmed}/${kind}`;
}

export interface PingOptions {
  /** Resolved base URL; defaults to resolveHealthcheckUrl(). */
  url?: string;
  /** Injectable fetch for testing; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Fire one monitoring ping. No-op when monitoring is unconfigured. Swallows all
 * errors (logged as a warn breadcrumb) so it can never break the run.
 */
export async function pingHealthcheck(kind: HealthcheckKind, opts: PingOptions = {}): Promise<void> {
  const base = opts.url ?? resolveHealthcheckUrl();
  if (!base) return; // monitoring disabled

  const fetchImpl = opts.fetchImpl ?? fetch;
  const target = buildHealthcheckUrl(base, kind);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PING_TIMEOUT_MS);

  try {
    await fetchImpl(target, { method: "POST", signal: controller.signal });
    logJson({ phase: "healthcheck", kind, status: "ok" });
  } catch (err) {
    // Non-blocking: a monitoring ping must never affect the pipeline.
    logJson({
      phase: "healthcheck",
      kind,
      status: "warn",
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}
