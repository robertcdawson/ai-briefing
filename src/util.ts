export function logJson(o: Record<string, unknown>): void {
  console.log(JSON.stringify(o));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function withHardTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race<T>([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms),
    ),
  ]);
}

export interface RetryOpts {
  attempts?: number;
  baseMs?: number;
  label?: string;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  const label = opts.label ?? "operation";
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const extra: Record<string, unknown> = {};
      if (err && typeof err === "object") {
        const e = err as { status?: unknown; error?: unknown };
        if ("status" in e && e.status !== undefined) extra.status = e.status;
        if ("error" in e && e.error !== undefined) extra.providerError = e.error;
      }
      logJson({ phase: "retry", label, attempt, attempts, status: "error", error: msg, ...extra });
      if (attempt < attempts) {
        await sleep(baseMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastErr;
}
