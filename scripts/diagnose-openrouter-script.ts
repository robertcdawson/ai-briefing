import "dotenv/config";
import OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";
import {
  buildScriptCompletionParams,
  resolveScriptModel,
  resolveScriptTimeoutMs,
  selectDailyPersona,
  type ScriptCompletionParams,
  validateScriptResponse,
} from "../src/script.js";
import type { StoryCluster } from "../src/types.js";
import { getChatCompletionAssistantText, logJson, withHardTimeout } from "../src/util.js";

const MINIMAL_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    summary: { type: "string" },
  },
  required: ["ok", "summary"],
  additionalProperties: false,
} as const;

const SCRIPT_PROBE_CLUSTERS: StoryCluster[] = [
  {
    canonicalKey: "diagnostic-structured-output",
    category: "research",
    headline: "Diagnostic probe checks structured script output",
    whyItMatters:
      "This validates whether the configured OpenRouter script model can return the production JSON schema.",
    caveat: "The story is synthetic and should only be used for API diagnostics.",
    sources: [{ url: "https://example.com/openrouter-diagnostic", publisher: "Diagnostic" }],
  },
];

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const model = resolveScriptModel(
    process.env.OPENROUTER_DIAGNOSTIC_MODEL ?? process.env.OPENROUTER_SCRIPT_MODEL,
  );
  const timeoutMs = resolveScriptTimeoutMs(process.env.OPENROUTER_SCRIPT_TIMEOUT_MS);
  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    timeout: timeoutMs,
  });

  logJson({
    phase: "diagnostic",
    status: "start",
    model,
    timeoutMs,
    probes: ["minimal_schema", "script_schema"],
  });

  const minimalOk = await runProbe(
    client,
    "minimal_schema",
    buildMinimalCompletionParams(model),
    timeoutMs,
  );
  const scriptOk = await runProbe(
    client,
    "script_schema",
    buildProductionScriptProbeParams(model),
    timeoutMs,
  );

  if (!minimalOk || !scriptOk) {
    process.exitCode = 1;
  }
}

function buildMinimalCompletionParams(model: string): ScriptCompletionParams {
  return {
    model,
    messages: [
      {
        role: "system",
        content: "Return only JSON matching the provided schema.",
      },
      {
        role: "user",
        content: "Return { ok: true, summary: a short sentence }.",
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "openrouter_diagnostic",
        strict: true,
        schema: MINIMAL_SCHEMA,
      },
    },
    max_tokens: 1024,
    provider: {
      require_parameters: true,
    },
    stream: false,
    temperature: 0,
  };
}

function buildProductionScriptProbeParams(model: string): ScriptCompletionParams {
  const date = process.env.EPISODE_DATE ?? new Date().toISOString().slice(0, 10);
  return buildScriptCompletionParams(
    model,
    selectDailyPersona(date),
    date,
    SCRIPT_PROBE_CLUSTERS,
  );
}

async function runProbe(
  client: OpenAI,
  label: string,
  params: ScriptCompletionParams,
  timeoutMs: number,
): Promise<boolean> {
  const started = Date.now();
  logJson({
    phase: "diagnostic.request",
    label,
    model: params.model,
    responseFormatType: params.response_format?.type,
    responseFormatName:
      params.response_format?.type === "json_schema"
        ? params.response_format.json_schema.name
        : undefined,
    responseFormatStrict:
      params.response_format?.type === "json_schema"
        ? params.response_format.json_schema.strict
        : undefined,
    maxTokens: params.max_tokens,
    requireParameters: params.provider.require_parameters,
    stream: params.stream,
  });

  let completion: ChatCompletion;
  try {
    completion = await withHardTimeout(
      client.chat.completions.create(params),
      timeoutMs,
      `diagnostic.openrouter.${label}.${params.model}`,
    );
  } catch (err) {
    logJson({
      phase: "diagnostic.response",
      label,
      status: "error",
      durationMs: Date.now() - started,
      error: safeCaughtError(err),
    });
    return false;
  }

  logJson({
    phase: "diagnostic.response",
    label,
    status: "ok",
    durationMs: Date.now() - started,
    ...summarizeCompletion(completion),
  });

  let content: string;
  try {
    content = getChatCompletionAssistantText(completion, `OpenRouter diagnostic ${label}`);
  } catch (err) {
    logJson({
      phase: "diagnostic.content",
      label,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  try {
    const parsed = JSON.parse(content);
    if (label === "script_schema") {
      validateScriptResponse(parsed, SCRIPT_PROBE_CLUSTERS);
    }
  } catch (err) {
    logJson({
      phase: "diagnostic.parse",
      label,
      status: "error",
      contentChars: content.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  logJson({
    phase: "diagnostic.parse",
    label,
    status: "ok",
    contentChars: content.length,
  });
  return true;
}

function summarizeCompletion(completion: ChatCompletion): Record<string, unknown> {
  const choice = completion.choices?.[0];
  const openRouterChoice = choice as
    | { native_finish_reason?: string | null; error?: unknown }
    | undefined;
  return compactRecord({
    responseKeys: sortedObjectKeys(completion),
    id: completion.id,
    model: completion.model,
    object: completion.object,
    choiceCount: completion.choices?.length ?? 0,
    firstChoiceKeys: sortedObjectKeys(choice),
    finishReason: choice?.finish_reason,
    nativeFinishReason: openRouterChoice?.native_finish_reason,
    choiceError: safeProviderError(openRouterChoice?.error),
    responseError: safeProviderError((completion as { error?: unknown }).error),
    usage: safeScalarRecord(completion.usage),
  });
}

function safeCaughtError(error: unknown): unknown {
  if (!error || typeof error !== "object") {
    return String(error);
  }
  const candidate = error as { message?: unknown; status?: unknown; error?: unknown };
  return compactRecord({
    message: isSafeScalar(candidate.message) ? truncateIfString(candidate.message) : undefined,
    status: isSafeScalar(candidate.status) ? candidate.status : undefined,
    providerError: safeProviderError(candidate.error),
  });
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function sortedObjectKeys(input: object | null | undefined): string[] | undefined {
  if (!input) return undefined;
  return Object.keys(input).sort();
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

await main();
