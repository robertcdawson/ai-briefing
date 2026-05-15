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
  choices?: ReadonlyArray<{
    finish_reason?: string | null;
    message?: { content?: string | null } | null;
  }>;
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
  const detail = {
    choiceCount: completion.choices?.length ?? 0,
    finish_reason: choice?.finish_reason,
  };
  throw new Error(`${context}: missing assistant message content (${JSON.stringify(detail)})`);
}
