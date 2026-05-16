export function logJson(o: Record<string, unknown>): void {
  console.log(JSON.stringify(o));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function withHardTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
  });

  return Promise.race<T>([p, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
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

/** Shape returned by OpenAI-compatible chat completion APIs (including OpenRouter). */
export interface ChatCompletionLike {
  id?: string;
  model?: string;
  object?: string;
  choices?: ReadonlyArray<{
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    error?: unknown;
    message?: { content?: unknown } | null;
  }>;
  usage?: object | null;
}

/**
 * Reads the first assistant text message. Uses optional chaining on `choices` because
 * some providers omit `choices` on certain failure paths; `choices[0]` would throw.
 */
export function getChatCompletionAssistantText(
  completion: ChatCompletionLike,
  context: string,
): string {
  const choice = completion.choices?.[0];
  const raw = choice?.message?.content;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  const detail = compactRecord({
    id: completion.id,
    model: completion.model,
    object: completion.object,
    choiceCount: completion.choices?.length ?? 0,
    finish_reason: choice?.finish_reason,
    native_finish_reason: choice?.native_finish_reason,
    choiceError: safeProviderError(choice?.error),
    usage: safeScalarRecord(completion.usage),
  });
  throw new Error(`${context}: missing assistant message content (${JSON.stringify(detail)})`);
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function safeScalarRecord(input: object | null | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const entries: Array<readonly [string, string | number | boolean | null]> = [];
  for (const [key, value] of Object.entries(input)) {
    if (isSafeScalar(value)) {
      entries.push([key, truncateIfString(value)] as const);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function safeProviderError(error: unknown): unknown {
  if (error === undefined) return undefined;
  if (isSafeScalar(error)) return truncateIfString(error);
  if (!error || typeof error !== "object") return String(error);

  const candidate = error as Record<string, unknown>;
  const allowedKeys = ["code", "message", "param", "status", "type"];
  const entries: Array<readonly [string, string | number | boolean | null]> = [];
  for (const key of allowedKeys) {
    const value = candidate[key];
    if (isSafeScalar(value)) {
      entries.push([key, truncateIfString(value)] as const);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : "[object]";
}

function isSafeScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function truncateIfString(value: string | number | boolean | null): string | number | boolean | null {
  if (typeof value !== "string") return value;
  return value.length > 300 ? `${value.slice(0, 300)}...` : value;
}
