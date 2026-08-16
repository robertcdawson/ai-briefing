import "dotenv/config";
import OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { buildRecentPhraseProfile, loadRecentStyleSnippets } from "../src/ledger.js";
import { loadAllRecords } from "../src/publish.js";
import {
  buildScriptCompletionParams,
  resolveScriptModel,
  resolveScriptTimeoutMs,
  type ScriptCompletionParams,
  type ScriptResponse,
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

  const { clusters, realEpisode } = await resolveProbeClusters();
  logJson({
    phase: "diagnostic.clusters",
    realEpisode,
    clusters: clusters.length,
    date: process.env.EPISODE_DATE,
  });

  const minimalOk = await runProbe(
    client,
    "minimal_schema",
    buildMinimalCompletionParams(model),
    timeoutMs,
    clusters,
  );
  const scriptOk = await runProbe(
    client,
    "script_schema",
    await buildProductionScriptProbeParams(model, clusters),
    timeoutMs,
    clusters,
  );

  if (!minimalOk || !scriptOk) {
    process.exitCode = 1;
  }
}

/**
 * Real-episode mode: when EPISODE_DATE names a published episode whose sidecar
 * carries curation records, replay those stories through the current prompt so
 * prompt changes can be compared against the actually-published transcript.
 * Sidecars don't store per-story source URLs, so a placeholder source stands in.
 *
 * Note: `stance` is not replayed here. It's an OUTPUT of the day being
 * replayed (what the host said), not an input to its own script prompt —
 * its input-side use is as `followUp.priorStance` on a *later* day's
 * replay, which this sidecar-to-cluster mapping doesn't have a "later day"
 * to attach to. Carrying it in here would misrepresent the original prompt.
 */
async function resolveProbeClusters(): Promise<{
  clusters: StoryCluster[];
  realEpisode: boolean;
}> {
  const date = process.env.EPISODE_DATE;
  if (!date) return { clusters: SCRIPT_PROBE_CLUSTERS, realEpisode: false };

  const records = await loadAllRecords();
  const record = records.find((r) => r.date === date);
  if (!record || !Array.isArray(record.curation) || record.curation.length === 0) {
    return { clusters: SCRIPT_PROBE_CLUSTERS, realEpisode: false };
  }

  const clusters = record.curation.map((cr, index) => ({
    canonicalKey: cr.canonicalKey,
    category: cr.category,
    headline: cr.headline,
    whyItMatters: cr.whyItMatters,
    caveat: cr.caveat,
    specifics: cr.specifics,
    importance: cr.importance,
    sources: [
      {
        publisher: "Replayed Episode",
        url: `https://example.com/replay/${date}/story-${index + 1}`,
      },
    ],
  }));
  return { clusters, realEpisode: true };
}

function printGeneratedScript(response: ScriptResponse): void {
  const parts: string[] = ["", "===== GENERATED SCRIPT =====", "", ...response.intro];
  for (const segment of response.segments) {
    parts.push("", `## ${segment.title}`, "", ...segment.chunks);
  }
  parts.push("", "## Outro", "", ...response.outro, "", "===== END SCRIPT =====");
  console.log(parts.join("\n"));
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

async function buildProductionScriptProbeParams(
  model: string,
  clusters: StoryCluster[],
): Promise<ScriptCompletionParams> {
  const date = process.env.EPISODE_DATE ?? new Date().toISOString().slice(0, 10);
  const recentStyle = await loadRecentStyleSnippets(date).catch(() => []);
  const phraseProfile = await buildRecentPhraseProfile(date).catch(() => []);
  return buildScriptCompletionParams(model, date, clusters, { recentStyle, phraseProfile });
}

async function runProbe(
  client: OpenAI,
  label: string,
  params: ScriptCompletionParams,
  timeoutMs: number,
  clusters: StoryCluster[],
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
      validateScriptResponse(parsed, clusters);
      printGeneratedScript(parsed as ScriptResponse);
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
