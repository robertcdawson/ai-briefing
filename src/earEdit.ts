/**
 * The ear edit: a low-temperature copy-editing pass between script and tts
 * that mechanically enforces the emphasis budget — deleting warm-up
 * sentences and self-endorsements, breaking runs of same-shape sentences,
 * collapsing unearned triads — on a script the writer has already produced.
 *
 * Deliberately non-blocking: any failure (missing key, malformed response,
 * a merge that fails validation, a word-count blowout) falls back to the
 * unedited script rather than failing the pipeline. This stage can only
 * ever make the episode equal to or better than what writeScript produced.
 */
import type { Episode, NarrationChunk, StoryCluster } from "./types.js";
import type { RecentPhraseProfile } from "./ledger.js";
import {
  SCRIPT_RESPONSE_SCHEMA,
  assertNoWornPhrases,
  createScriptCompletionClient,
  normalizeScriptResponse,
  resolveScriptModels,
  resolveScriptTimeoutMs,
  validateScriptResponse,
  type ScriptCompletionClient,
  type ScriptCompletionParams,
  type ScriptResponse,
  type ScriptSegmentResponse,
} from "./script.js";
import { getChatCompletionAssistantText, logJson, withHardTimeout, withRetry } from "./util.js";

const EAR_EDIT_ATTEMPTS_PER_MODEL = 2;
const EAR_EDIT_MAX_TOKENS = 9000;
const DEFAULT_EAR_EDIT_RETRY_BASE_MS = 500;
// Looser than the ±10% the prompt asks for — a guard against a runaway edit,
// not a re-implementation of the prompt's own length instruction.
const EAR_EDIT_WORD_COUNT_TOLERANCE = 0.3;

/** Default ON; imitates resolveAudioCuesEnabled (src/audio.ts). */
export function resolveEarEditEnabled(value = process.env.EAR_EDIT_ENABLED): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

export function resolveEarEditModels(env: NodeJS.ProcessEnv = process.env): string[] {
  return resolveScriptModels(env.OPENROUTER_EAR_EDIT_MODEL ?? env.OPENROUTER_SCRIPT_MODEL);
}

/**
 * Same intro/segments/outro shape as SCRIPT_RESPONSE_SCHEMA (reused by
 * reference, not copied) plus a required "edits" array the model uses to
 * record what it changed and why — useful for logs, not enforced.
 */
export const EAR_EDIT_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    intro: SCRIPT_RESPONSE_SCHEMA.properties.intro,
    segments: SCRIPT_RESPONSE_SCHEMA.properties.segments,
    outro: SCRIPT_RESPONSE_SCHEMA.properties.outro,
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          location: { type: "string" },
          reason: { type: "string" },
        },
        required: ["location", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["intro", "segments", "outro", "edits"],
  additionalProperties: false,
} as const;

export interface EarEditRecord {
  location: string;
  reason: string;
}

export interface EarEditResponse extends ScriptResponse {
  edits: EarEditRecord[];
}

export interface EarEditResult {
  episode: Episode;
  edited: boolean;
  edits: EarEditRecord[];
}

export interface EarEditOptions {
  completionClient?: ScriptCompletionClient;
  retryBaseMs?: number;
}

export function buildEarEditSystemPrompt(): string {
  return `You are a copy editor doing one light pass on a finished podcast script before it goes to voice. Return the SAME script as JSON, with minimal, targeted edits only:

- Delete warm-up sentences and self-endorsements ("worth sitting with", "that's the part that matters", "and that's exactly the point", and kin) — cut straight to the point instead.
- Break up any run of 3 or more consecutive sentences that share the same rhetorical shape (e.g. three antitheses in a row, three short declaratives in a row) by rewriting one of them.
- Collapse a triad ("X, Y, and Z") that doesn't earn three genuinely distinct items into something tighter.
- Split any sentence that isn't sayable in one breath.
- Remove any sentence that closely paraphrases the editor's notes provided below — those notes are context for your judgment, never something to read aloud.

NEVER change segment count, segment order, segment titles, or sourceUrls — copy those through exactly as given. Never add facts, quotes, numbers, or claims that weren't already in the script. Keep the total word count within about 10% of the original.

For every change you make, add one entry to "edits": {location: a short pointer such as "segment 2, chunk 3" or "outro", reason: a short phrase}. If a chunk needed no changes, leave it untouched. If nothing in the whole script needed an edit, return the script unchanged and an empty "edits" array.

Return only JSON matching the provided schema.`;
}

export function buildEarEditUserPrompt(episode: Episode, clusters: StoryCluster[]): string {
  const scriptJson = JSON.stringify(
    {
      intro: episode.intro,
      segments: episode.segments.map((s) => ({
        title: s.title,
        chunks: s.chunks,
        sourceUrls: s.sourceUrls,
        stance: s.stance ?? null,
        delivery: s.delivery ?? null,
      })),
      outro: episode.outro,
    },
    null,
    2,
  );

  const notes = clusters
    .map(
      (c, i) =>
        `STORY ${i + 1}: ${c.headline}\n  Why it matters: ${c.whyItMatters}\n  Caveat: ${c.caveat}`,
    )
    .join("\n\n");

  return `Here is today's generated script as JSON:

${scriptJson}

Editor's notes for each story, for context only — never echo their wording on air:

${notes}

Return the edited script as JSON matching the provided schema.`;
}

export function buildEarEditCompletionParams(
  model: string,
  episode: Episode,
  clusters: StoryCluster[],
): ScriptCompletionParams {
  return {
    model,
    messages: [
      { role: "system", content: buildEarEditSystemPrompt() },
      { role: "user", content: buildEarEditUserPrompt(episode, clusters) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "ear_edit", strict: true, schema: EAR_EDIT_RESPONSE_SCHEMA },
    },
    max_tokens: EAR_EDIT_MAX_TOKENS,
    provider: {
      require_parameters: true,
    },
    stream: false,
    temperature: 0.3,
  };
}

/**
 * Merges an ear-edit response onto the original episode: only intro/outro
 * chunks and each segment's chunks are taken from the edit. Title,
 * sourceUrls, stance, and delivery are always forced from the original
 * segment — belt-and-braces so a model that ignores the "never change
 * sourceUrls" instruction can never actually break sourceUrls equality, and
 * so an edit can never silently drop a recorded stance or delivery hint.
 * Throws on any structural mismatch (segment count, a renamed title, a
 * missing/empty chunks array) so the caller's fallback path takes over.
 */
export function mergeEarEdit(original: Episode, response: EarEditResponse): Episode {
  if (!Array.isArray(response.intro) || response.intro.length === 0) {
    throw new Error("ear edit intro chunks must be a non-empty array");
  }
  if (!Array.isArray(response.outro) || response.outro.length === 0) {
    throw new Error("ear edit outro chunks must be a non-empty array");
  }
  if (!Array.isArray(response.segments) || response.segments.length !== original.segments.length) {
    const gotCount = Array.isArray(response.segments) ? response.segments.length : "non-array";
    throw new Error(`ear edit returned ${gotCount} segment(s), expected ${original.segments.length}`);
  }

  const segments = original.segments.map((originalSegment, i) => {
    const edited: ScriptSegmentResponse | undefined = response.segments[i];
    if (!edited) throw new Error(`ear edit missing segment ${i + 1}`);
    if (!Array.isArray(edited.chunks) || edited.chunks.length === 0) {
      throw new Error(`ear edit segment ${i + 1} chunks must be a non-empty array`);
    }
    const editedTitle = typeof edited.title === "string" ? edited.title.trim() : "";
    if (editedTitle !== originalSegment.title.trim()) {
      throw new Error(
        `ear edit segment ${i + 1} changed the title: expected "${originalSegment.title}", got "${edited.title}"`,
      );
    }
    return {
      title: originalSegment.title,
      chunks: edited.chunks,
      sourceUrls: originalSegment.sourceUrls,
      stance: originalSegment.stance,
      delivery: originalSegment.delivery,
    };
  });

  return {
    ...original,
    intro: response.intro,
    segments,
    outro: response.outro,
  };
}

/**
 * Runs the ear edit and returns the result; on any failure, returns the
 * original episode unedited (edited: false). Never throws.
 */
export async function earEdit(
  episode: Episode,
  clusters: StoryCluster[],
  phraseProfile: RecentPhraseProfile,
  options: EarEditOptions = {},
): Promise<EarEditResult> {
  const fallback: EarEditResult = { episode, edited: false, edits: [] };

  try {
    const openRouterApiKey = process.env.OPENROUTER_API_KEY;
    const openAiApiKey = process.env.OPENAI_API_KEY;
    if (!openRouterApiKey && !openAiApiKey && !options.completionClient) {
      logJson({
        phase: "earEdit",
        status: "fallback",
        error: "OPENAI_API_KEY or OPENROUTER_API_KEY is not set",
      });
      return fallback;
    }

    const models = resolveEarEditModels();
    const timeoutMs = resolveScriptTimeoutMs(process.env.OPENROUTER_SCRIPT_TIMEOUT_MS);
    const completionClient =
      options.completionClient ?? createScriptCompletionClient(openRouterApiKey, openAiApiKey, timeoutMs);
    const retryBaseMs = options.retryBaseMs ?? DEFAULT_EAR_EDIT_RETRY_BASE_MS;
    const originalWordCount = countEpisodeWords(episode);

    for (const model of models) {
      try {
        const result = await withRetry(
          async () => {
            const completion = await withHardTimeout(
              completionClient.create(buildEarEditCompletionParams(model, episode, clusters)),
              timeoutMs,
              `earEdit.openrouter.${model}`,
            );

            const content = getChatCompletionAssistantText(completion, "OpenRouter ear edit");
            const parsed = JSON.parse(content) as EarEditResponse;
            normalizeScriptResponse(parsed);

            const merged = mergeEarEdit(episode, parsed);
            validateScriptResponse(merged, clusters);
            assertNoWornPhrases(merged, phraseProfile);

            const editedWordCount = countEpisodeWords(merged);
            const drift =
              originalWordCount === 0 ? 0 : Math.abs(editedWordCount - originalWordCount) / originalWordCount;
            if (drift > EAR_EDIT_WORD_COUNT_TOLERANCE) {
              throw new Error(
                `ear edit changed word count by ${Math.round(drift * 100)}% ` +
                  `(${originalWordCount} -> ${editedWordCount}), exceeding the ` +
                  `${Math.round(EAR_EDIT_WORD_COUNT_TOLERANCE * 100)}% guard`,
              );
            }

            return { episode: merged, edits: Array.isArray(parsed.edits) ? parsed.edits : [] };
          },
          { attempts: EAR_EDIT_ATTEMPTS_PER_MODEL, baseMs: retryBaseMs, label: "earEdit" },
        );

        logJson({ phase: "earEdit", status: "ok", edits: result.edits.length, model });
        return { episode: result.episode, edited: true, edits: result.edits };
      } catch (err) {
        logJson({
          phase: "earEdit",
          status: "fallback",
          model,
          error: err instanceof Error ? err.message : String(err),
        });
        // try the next candidate model, if any
      }
    }

    return fallback;
  } catch (err) {
    logJson({
      phase: "earEdit",
      status: "fallback",
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}

function countEpisodeWords(episode: Episode): number {
  const countChunks = (chunks: readonly NarrationChunk[]): number =>
    chunks.reduce((sum, chunk) => sum + chunk.trim().split(/\s+/).filter(Boolean).length, 0);
  return (
    countChunks(episode.intro) +
    episode.segments.reduce((sum, s) => sum + countChunks(s.chunks), 0) +
    countChunks(episode.outro)
  );
}
