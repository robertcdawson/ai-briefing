import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { buildInlineAudioTagRules } from "./audioTags.js";
import { resolveTTSProviderConfig } from "./ttsProvider.js";
import { getStoryCategoryLabel, STORY_CATEGORY_DEFINITIONS } from "./types.js";
import type { Episode, NarrationChunk, StoryCluster } from "./types.js";
import type { ChatCompletionLike } from "./util.js";
import { getChatCompletionAssistantText, logJson, withHardTimeout, withRetry } from "./util.js";

// Sonnet leads for prose quality (wit, persona adherence, varied phrasing);
// the cheaper models remain as availability fallbacks. Sonnet was briefly the
// default before (removed when strict-schema minLength/pattern constraints
// broke Bedrock-routed structured output); those constraints are long gone and
// curation already runs Sonnet with strict JSON schema daily.
export const DEFAULT_SCRIPT_MODELS = [
  "anthropic/claude-sonnet-4.6",
  "openai/gpt-4o-mini",
  "google/gemini-3.1-pro-preview",
] as const;
const DEFAULT_SCRIPT_TIMEOUT_MS = 360_000;
const MIN_SCRIPT_TIMEOUT_MS = 60_000;
const MAX_SCRIPT_TIMEOUT_MS = 900_000;
const SCRIPT_ATTEMPTS_PER_MODEL = 2;
const DEFAULT_SCRIPT_RETRY_BASE_MS = 500;
const MAX_SCRIPT_TOKENS = 8000;
const MIN_CHUNKS_PER_PART = 1;

export type ScriptCompletionParams = ChatCompletionCreateParamsNonStreaming & {
  provider: {
    require_parameters: true;
  };
};

export interface ScriptCompletionClient {
  create(params: ScriptCompletionParams): Promise<ChatCompletionLike>;
}

export interface WriteScriptOptions {
  completionClient?: ScriptCompletionClient;
  retryBaseMs?: number;
}

export interface DailyPersona {
  name: string;
  inspiration: string;
  delivery: string;
  opinionStance: string;
  humor: string;
  avoid: string;
}

export interface ScriptResponse {
  intro: NarrationChunk[];
  segments: ScriptSegmentResponse[];
  outro: NarrationChunk[];
}

export interface ScriptSegmentResponse {
  title: string;
  chunks: NarrationChunk[];
  sourceUrls: string[];
}

export const DAILY_PERSONAS: readonly DailyPersona[] = [
  {
    name: "The Golden-Age Newsreel Announcer",
    inspiration:
      "1940s radio newsreels: crisp headline cadence, theatrical urgency, and clean signposting.",
    delivery:
      "Authoritative, polished, and kinetic. Use strong verbs, short declarative sentences, and dramatic but controlled pacing.",
    opinionStance:
      "Make confident judgments when the evidence is solid. Call out weak claims, vague demos, and strategic spin.",
    humor:
      "A quick dry aside is fine, but keep the segment moving like a bulletin with a brain.",
    avoid:
      "Fake old-time slang, melodrama, patriotic bombast, celebrity impressions, or invented newsroom details.",
  },
  {
    name: "The Late-Night FM Futurist",
    inspiration:
      "1970s and 1980s FM radio intimacy: close-mic warmth, smooth transitions, and reflective pacing.",
    delivery:
      "Warm, unhurried, and slightly mysterious. Make complex AI stories feel like signals from the near future.",
    opinionStance:
      "Offer thoughtful, sometimes pointed analysis, especially when incentives or tradeoffs are hiding in plain sight.",
    humor:
      "Use low-key wit and understated irony. No bits that require acting or sound effects in the text.",
    avoid:
      "Mysticism, vague futurism, breathless hype, fake reverb cues, or dreamy language that muddies the facts.",
  },
  {
    name: "The Hardboiled Tech Detective",
    inspiration:
      "Classic radio noir narration: investigative framing, skeptical questions, and economical atmosphere.",
    delivery:
      "Lean, vivid, and suspicious in the useful sense. Frame each story as a case: evidence, motive, and loose ends.",
    opinionStance:
      "Be willing to say when a company story does not add up, while separating facts from inference.",
    humor:
      "One sharp noir-flavored line per segment at most, then return immediately to the reporting.",
    avoid:
      "Pastiche overload, fake accents, cynicism for its own sake, violence metaphors, or made-up scenes.",
  },
  {
    name: "The Morning Drive Contrarian",
    inspiration:
      "Classic morning radio energy: bright pacing, memorable hooks, quick turns, and personality-forward hosting.",
    delivery:
      "Energetic, direct, and conversational. Make the big takeaway easy to remember before the listener has finished coffee.",
    opinionStance:
      "Have strong opinions. Challenge lazy consensus, but anchor every critique in the provided story facts.",
    humor:
      "Use quick, clean punchlines and lightly opinionated phrasing. Keep jokes subordinate to comprehension.",
    avoid:
      "Shouting, forced banter, imaginary co-hosts, shock-jock tone, or contrarianism unsupported by evidence.",
  },
  {
    name: "The Global Shortwave Correspondent",
    inspiration:
      "Shortwave and international radio dispatches: compact field reports, station-ID clarity, and worldwide context.",
    delivery:
      "Measured, worldly, and vivid. Treat each segment like a dispatch from the frontier of AI deployment.",
    opinionStance:
      "Draw clear conclusions about global stakes, power shifts, and practical consequences without overstating certainty.",
    humor:
      "Sparse, wry, and observational. Let the occasional line land, then move on.",
    avoid:
      "Fake static cues, accents, geopolitical grandstanding, travelogue filler, or unsupported global claims.",
  },
];

const NARRATION_CHUNK_SCHEMA = {
  type: "string",
  description:
    "One read-aloud chunk of the host's monologue (roughly a sentence or two). No speaker labels, stage directions, or markdown.",
} as const;

export const SCRIPT_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    intro: {
      type: "array",
      items: NARRATION_CHUNK_SCHEMA,
      description:
        "Spoken intro hook as 2-3 narration chunks: lead with the single most consequential thing today, then preview why it matters. No 'welcome to' boilerplate.",
    },
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          chunks: {
            type: "array",
            items: NARRATION_CHUNK_SCHEMA,
            description:
              "The host's monologue for this story as several narration chunks. Cover what concretely happened, why it matters, a brief plain-English explainer when needed, the potential impact (good and bad), and an honest caveat. Scale depth to the story's importance; end with a short, specific transition.",
          },
          sourceUrls: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["title", "chunks", "sourceUrls"],
        additionalProperties: false,
      },
    },
    outro: {
      type: "array",
      items: NARRATION_CHUNK_SCHEMA,
      description:
        "Synthesis outro as 2-4 narration chunks identifying a pattern, theme, or contrast across the stories. End with a fresh, persona-flavored sign-off, never a stock farewell.",
    },
  },
  required: ["intro", "segments", "outro"],
  additionalProperties: false,
} as const;

const SEGMENT_LABEL_RULES = STORY_CATEGORY_DEFINITIONS
  .map((category) => `  - ${category.id}: "${category.label}: {headline}"`)
  .join("\n");

export const BANNED_SCRIPT_PHRASES = [
  "dive in",
  "diving in",
  "stay curious",
  "stay informed",
  "stay tuned",
  "until next time",
  "pivotal moment",
  "let's not forget",
  "the stakes",
  "crucial",
  "game-changer",
  "buckle up",
  "that's a wrap",
] as const;

function buildSystemPromptBase(allowAudioTags: boolean): string {
  const chunkPurityRule = allowAudioTags
    ? "- Do not include speaker labels, stage directions, reactions, fake laughter, or audio cues. The ONLY bracketed text allowed is the approved inline delivery tags described below."
    : "- Do not include speaker labels, stage directions, reactions, fake laughter, audio cues, or bracketed pauses.";
  const noMarkupRule = allowAudioTags
    ? `- No bullet points, no markdown, no stage directions, no "[pause]" cues. Approved inline delivery tags are the only exception.`
    : `- No bullet points, no markdown, no stage directions, no "[pause]" cues.`;
  const audioTagSection = allowAudioTags ? `\n\n${buildInlineAudioTagRules()}` : "";

  return `You are the writer for a daily AI news podcast called "AI Briefing", delivered by a single host speaking solo. Write a tight, natural, conversational monologue. Match this structure exactly:

- INTRO HOOK (2-3 narration chunks): Begin with an engaging hook built on the single most surprising or consequential fact of the day, then name the date and preview why today matters. Not a vague teaser question, and not a dry table of contents.
- STORY SEGMENTS: Write exactly one segment per provided story cluster, in the order provided (most important first). For each story, cover (in whatever order feels natural) what concretely happened, why it matters for AI builders and researchers with a listener-oriented takeaway, a plain-English gloss of any jargon on first use, the potential impact both good and bad, and an honest caveat about what's uncertain, missing, or overhyped. End each segment with a smooth, short, specific transition into the next story (or, for the last segment, into the outro).
  - FOLLOW-UP STORIES: When a story cluster is marked as a follow-up (it includes a "Previously" line with prior framing), open that segment as a continuation, not a fresh introduction. Reference how the situation has developed since the prior coverage — e.g. "the rumor we flagged Monday is now confirmed", "what started as a proposal has become policy". Do NOT re-introduce the topic as if the listener has never heard of it. New stories (no "Previously" line) are introduced normally.
  - CONFIDENCE AND SOURCING: Calibrate how firmly you state each story to its corroboration (each cluster includes a "Corroboration: N independent source(s)" line). A single-source story must be voiced as tentative and attributed — "one outlet reports", "this isn't confirmed yet" — never as established fact. When several independent sources corroborate a story, you can state its core facts plainly. When a story reads as vendor hype or an unverified claim, name that skepticism briefly rather than relaying it credulously. Do NOT over-hedge well-corroborated facts — calibration cuts both ways.
  - Do NOT use the same beat order in every segment. Vary how each story unfolds so the episode doesn't read as a template.
- SYNTHESIS OUTRO (2-4 narration chunks): Identify a pattern, theme, or contrast across the provided stories. End with a fresh, persona-flavored sign-off.

Length and depth:
- This is a solo show, not a fixed-length one. Let the news set the length: cover everything that matters, but keep the whole episode under about ten minutes (roughly 1500 spoken words total).
- Scale depth to each story's importance score: give the lead story the most room and real explanation; treat minor items briefly. Prioritize explaining the most important item well over hitting any particular length.
- Never pad. On a slow news day, a shorter episode with fewer, tighter segments is the right answer.

Narration chunks:
- Return each part as an array of short narration chunks (roughly a sentence or two each). The chunks are read back-to-back as one continuous monologue, so they must flow naturally in order.
${chunkPurityRule}

Recurring segment labels:
- The first segment title MUST begin "Top Story: " followed by the story headline.
- Later segment titles MUST use the provided category's recurring label:
${SEGMENT_LABEL_RULES}
- Keep titles compact. Do not invent new segment label names.

Voice rules:
- Conversational and intelligent, not breathless or hyped. Sound like a smart person talking through the news, not reading a bulletin. Use contractions.
- Sound alert and genuinely engaged, while staying skeptical and precise; never announcer-y or fake-enthusiastic.
- Bring some attitude: witty, occasionally cynical, with opinions grounded in evidence. Care visibly about who a story helps or hurts. Never a neutral press-release reader.
- Every opinion must be grounded in the provided facts. Prefer sharp analysis over neutral summary, but never sacrifice accuracy for personality.
- Ground every story in the concrete: each segment must carry at least one specific number, named person or organization, or short direct quote drawn from the provided material. Specifics beat adjectives.
- Optimize for information retention: vary sentence rhythm, front-load concrete details, and reinforce each segment's key takeaway once near the end.
- Spoken pacing: mix crisp short sentences with medium explanatory sentences. Avoid dense clauses; keep most sentences under about 24 words.
- TTS-friendly prosody: use commas for natural breath pauses; prefer short clauses over nested lists; one rhetorical question per segment at most when it sharpens the point.
- Use light, dry humor sparingly (about one quick line per segment max) when it helps recall, never at the expense of accuracy or clarity.
- At most ONE analogy or metaphor in the entire episode, and only when it genuinely makes a hard idea click. Do not reach for one every segment.
- Avoid recycled filler and verbal tics. Never use stock phrases like "This is a big deal.", and never open a chunk with analogy crutches like "Think of it as" or "It's like". Find fresh phrasing every time.
- BANNED PHRASES. Never say any of these, in any tense or close variation: ${BANNED_SCRIPT_PHRASES.map((phrase) => `"${phrase}"`).join(", ")}. They are worn-out podcast filler; find specific, persona-flavored language instead.
- The sign-off must be one short line that could only belong to today's persona, different every episode. Never a stock farewell.
- Read-aloud-friendly: short sentences, no parenthetical asides, no stage-direction punctuation; avoid em-dashes that force awkward pauses.
- Explain jargon only when it helps: define specialized terms in 8-14 plain words and keep moving.
- Transitions must be one sentence, under about 12 words, and specific to the next story. Vary them, and avoid formulaic phrases like "next up", "now, onto our next story", or "now, let's turn to".
- No "Welcome to" or "Today on AI Briefing" boilerplate openings, which go stale fast.
${noMarkupRule}
- Numbers in spoken form when natural ("about three billion" not "3,000,000,000").
- Don't read URLs aloud.

Daily persona rules:
- Use the provided daily persona to shape the whole episode's tone, word choice, and pacing. It is a style lens, not a character bit, and its flavor should be noticeable across the script, not decorative.
- Let the persona visibly shape the hook, the word choice, and the sign-off, and give it one understated running angle that surfaces two or three times across the episode in different words.
- Keep the episode recognizably "AI Briefing": accurate, useful, skeptical, and concise.
- Do not imitate real people or copyrighted characters. No celebrity impressions.
- Do not invent audio cues, accents, scenes, sound effects, facts, quotes, reactions, or source details to fit the persona or the conversation.

Each segment's sourceUrls MUST be exactly the urls provided for that cluster. Do not invent or omit any.

Return only JSON matching the provided schema.${audioTagSection}`;
}

export function selectDailyPersona(date: string): DailyPersona {
  const index = stableHash(date) % DAILY_PERSONAS.length;
  const persona = DAILY_PERSONAS[index];
  if (!persona) throw new Error("No daily personas configured");
  return persona;
}

export interface ScriptPromptOptions {
  /** Permit approved inline delivery tags (expressive TTS models only). */
  allowAudioTags?: boolean;
}

export function buildSystemPrompt(
  persona: DailyPersona,
  options: ScriptPromptOptions = {},
): string {
  return `${buildSystemPromptBase(options.allowAudioTags === true)}

Today's original broadcast persona:
- Persona: ${persona.name}
- Inspired by: ${persona.inspiration}
- Delivery: ${persona.delivery}
- Opinion stance: ${persona.opinionStance}
- Humor: ${persona.humor}
- Avoid: ${persona.avoid}`;
}

export function buildUserPrompt(date: string, clusters: StoryCluster[]): string {
  const lines = clusters.map((c, i) => {
    const sources = c.sources.map((s) => `${s.publisher}: ${s.url}`).join("\n      ");
    const categoryLabel = getStoryCategoryLabel(c.category);
    const importance = typeof c.importance === "number" ? `${Math.round(c.importance)}/100` : "unscored";
    const sourceCount = c.sources.length;
    const corroboration = `${sourceCount} independent source${sourceCount === 1 ? "" : "s"}`;
    const followUpLine = c.followUp
      ? `\n  Previously (${c.followUp.priorDate.replace(/\s+/g, " ").trim()}): ${c.followUp.priorFraming.replace(/\s+/g, " ").trim()} — this is a FOLLOW-UP/update, not a new story.`
      : "";
    return `STORY ${i + 1}: ${c.headline}
  Category: ${categoryLabel} (${c.category})
  Importance: ${importance}
  Corroboration: ${corroboration}
  Why it matters: ${c.whyItMatters}
  Caveat: ${c.caveat}${followUpLine}
  Sources:
      ${sources}`;
  });
  return `Today is ${date}. Write the podcast script for the following ${clusters.length} story cluster${clusters.length === 1 ? "" : "s"}, in priority order (most important first). Return exactly ${clusters.length} segment object${clusters.length === 1 ? "" : "s"}; never invent or pad. Spend more time on the higher-importance stories and explain them in adequate detail; keep lower-importance stories brief. Keep the whole episode under about ten minutes:

${lines.join("\n\n")}`;
}

export function resolveScriptModels(requestedModel: string | undefined): string[] {
  const models = requestedModel
    ?.split(",")
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
  return models && models.length > 0 ? models : [...DEFAULT_SCRIPT_MODELS];
}

export function resolveScriptModel(requestedModel: string | undefined): string {
  return resolveScriptModels(requestedModel)[0] ?? DEFAULT_SCRIPT_MODELS[0];
}

export function resolveScriptTimeoutMs(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_SCRIPT_TIMEOUT_MS;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return DEFAULT_SCRIPT_TIMEOUT_MS;
  const rounded = Math.round(parsed);
  if (rounded < MIN_SCRIPT_TIMEOUT_MS || rounded > MAX_SCRIPT_TIMEOUT_MS) {
    return DEFAULT_SCRIPT_TIMEOUT_MS;
  }
  return rounded;
}

export async function writeScript(
  date: string,
  clusters: StoryCluster[],
  options: WriteScriptOptions = {},
): Promise<Episode> {
  const started = Date.now();
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  const openAiApiKey = process.env.OPENAI_API_KEY;
  if (!openRouterApiKey && !openAiApiKey && !options.completionClient) {
    throw new Error("OPENAI_API_KEY or OPENROUTER_API_KEY is not set");
  }
  if (clusters.length === 0) throw new Error("writeScript: no clusters provided");
  const persona = selectDailyPersona(date);
  const models = resolveScriptModels(process.env.OPENROUTER_SCRIPT_MODEL);
  const timeoutMs = resolveScriptTimeoutMs(process.env.OPENROUTER_SCRIPT_TIMEOUT_MS);
  // Inline delivery tags are only written when the configured TTS model will
  // interpret them; otherwise the script stays plain text.
  const promptOptions: ScriptPromptOptions = {
    allowAudioTags: resolveTTSProviderConfig().supportsInlineAudioTags,
  };
  const completionClient =
    options.completionClient ??
    createScriptCompletionClient(openRouterApiKey, openAiApiKey, timeoutMs);
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_SCRIPT_RETRY_BASE_MS;

  let parsed: ScriptResponse | undefined;
  let selectedModel: string | undefined;
  let lastErr: unknown;

  for (const [modelIndex, model] of models.entries()) {
    try {
      parsed = await withRetry(
        async () => {
          const completion = await withHardTimeout(
            completionClient.create(
              buildScriptCompletionParams(model, persona, date, clusters, promptOptions),
            ),
            timeoutMs,
            `script.openrouter.${model}`,
          );

          const content = getChatCompletionAssistantText(completion, "OpenRouter script");

          const response = JSON.parse(content) as ScriptResponse;
          const repairedSegments = reconcileScriptSourceUrls(response, clusters);
          if (repairedSegments > 0) {
            logJson({
              phase: "script.source_urls_repair",
              status: "ok",
              repairedSegments,
            });
          }
          validateScriptResponse(response, clusters);
          return response;
        },
        { attempts: SCRIPT_ATTEMPTS_PER_MODEL, baseMs: retryBaseMs, label: "script" },
      );
      selectedModel = model;
      break;
    } catch (err) {
      lastErr = err;
      const nextModel = models[modelIndex + 1];
      if (!nextModel) break;
      logJson({
        phase: "script.model_fallback",
        status: "error",
        model,
        nextModel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!parsed || !selectedModel) {
    throw lastErr ?? new Error("script generation failed without an error");
  }

  const wordCount =
    countChunkWords(parsed.intro) +
    parsed.segments.reduce((sum, s) => sum + countChunkWords(s.chunks), 0) +
    countChunkWords(parsed.outro);

  const episode: Episode = {
    date,
    title: `AI Briefing — ${formatLongDate(date)}`,
    intro: parsed.intro,
    segments: parsed.segments,
    outro: parsed.outro,
    audioPath: "",
    byteLength: 0,
    durationSeconds: 0,
  };

  logJson({
    phase: "script",
    status: "ok",
    durationMs: Date.now() - started,
    segments: episode.segments.length,
    wordCount,
    persona: persona.name,
    model: selectedModel,
    candidateModels: models.length,
    timeoutMs,
    inlineAudioTags: promptOptions.allowAudioTags === true,
  });

  return episode;
}

function createScriptCompletionClient(
  openRouterApiKey: string | undefined,
  openAiApiKey: string | undefined,
  timeoutMs: number,
): ScriptCompletionClient {
  const openRouterClient = openRouterApiKey
    ? new OpenAI({
        apiKey: openRouterApiKey,
        baseURL: "https://openrouter.ai/api/v1",
        timeout: timeoutMs,
      })
    : undefined;
  const openAiClient = openAiApiKey
    ? new OpenAI({
        apiKey: openAiApiKey,
        timeout: timeoutMs,
      })
    : undefined;

  return {
    create: (params) => {
      if (openAiClient && isOpenRouterOpenAIModel(params.model)) {
        return openAiClient.chat.completions.create(buildDirectOpenAICompletionParams(params));
      }
      if (!openRouterClient) {
        throw new Error(
          isOpenRouterOpenAIModel(params.model)
            ? "OPENAI_API_KEY or OPENROUTER_API_KEY is not set"
            : "OPENROUTER_API_KEY is not set",
        );
      }
      return openRouterClient.chat.completions.create(params);
    },
  };
}

export function buildDirectOpenAICompletionParams(
  params: ScriptCompletionParams,
): ChatCompletionCreateParamsNonStreaming {
  if (!isOpenRouterOpenAIModel(params.model)) {
    throw new Error(`Cannot route non-OpenAI model directly to OpenAI: ${params.model}`);
  }

  const { provider: _provider, ...directParams } = params;
  return {
    ...directParams,
    model: stripOpenRouterOpenAIPrefix(params.model),
  };
}

function isOpenRouterOpenAIModel(model: string): boolean {
  return model.startsWith("openai/") && stripOpenRouterOpenAIPrefix(model).length > 0;
}

function stripOpenRouterOpenAIPrefix(model: string): string {
  return model.slice("openai/".length);
}

export function buildScriptCompletionParams(
  model: string,
  persona: DailyPersona,
  date: string,
  clusters: StoryCluster[],
  promptOptions: ScriptPromptOptions = {},
): ScriptCompletionParams {
  return {
    model,
    messages: [
      { role: "system", content: buildSystemPrompt(persona, promptOptions) },
      { role: "user", content: buildUserPrompt(date, clusters) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "episode_script", strict: true, schema: SCRIPT_RESPONSE_SCHEMA },
    },
    max_tokens: MAX_SCRIPT_TOKENS,
    provider: {
      require_parameters: true,
    },
    stream: false,
    temperature: 0.7,
  };
}

/** Fill omitted cluster source URLs from curation; still reject invented extras. */
export function reconcileScriptSourceUrls(
  response: ScriptResponse,
  clusters: StoryCluster[],
): number {
  let repairedSegments = 0;

  for (let i = 0; i < clusters.length; i += 1) {
    const segment = response.segments[i];
    const cluster = clusters[i];
    if (!segment || !cluster) continue;

    const expectedUrls = cluster.sources.map((source) => source.url);
    const receivedUrls = Array.isArray(segment.sourceUrls) ? segment.sourceUrls : [];
    const diff = diffNormalizedUrls(receivedUrls, expectedUrls);
    if (diff.extra.length > 0) continue;
    if (diff.missing.length === 0) continue;

    segment.sourceUrls = expectedUrls;
    repairedSegments += 1;
  }

  return repairedSegments;
}

export function validateScriptResponse(
  response: ScriptResponse,
  clusters: StoryCluster[],
): void {
  if (!response || typeof response !== "object") {
    throw new Error("script response must be an object");
  }

  if (!Array.isArray(response.segments)) {
    throw new Error("script response segments must be an array");
  }

  validateNarrationChunks("intro", response.intro);
  validateNarrationChunks("outro", response.outro);

  if (response.segments.length !== clusters.length) {
    throw new Error(
      `script returned ${response.segments.length} segment(s), expected ${clusters.length}`,
    );
  }

  for (let i = 0; i < clusters.length; i += 1) {
    const segment = response.segments[i];
    const cluster = clusters[i];
    if (!segment || !cluster) throw new Error(`script response missing segment ${i + 1}`);
    if (typeof segment.title !== "string" || segment.title.trim().length === 0) {
      throw new Error(`script segment ${i + 1} title must be a non-empty string`);
    }
    validateNarrationChunks(`segment ${i + 1}`, segment.chunks);

    if (!Array.isArray(segment.sourceUrls)) {
      throw new Error(`script segment ${i + 1} sourceUrls must be an array`);
    }
    if (segment.sourceUrls.some((url) => typeof url !== "string")) {
      throw new Error(`script segment ${i + 1} sourceUrls must contain only strings`);
    }

    const expectedUrls = cluster.sources.map((source) => source.url);
    const diff = diffNormalizedUrls(segment.sourceUrls, expectedUrls);
    if (diff.missing.length > 0 || diff.extra.length > 0) {
      throw new Error(
        `script segment ${i + 1} sourceUrls do not match the story cluster: ` +
          `missing=${formatUrlList(diff.missing)} extra=${formatUrlList(diff.extra)}`,
      );
    }
  }
}

function validateNarrationChunks(label: string, chunks: unknown): asserts chunks is NarrationChunk[] {
  if (!Array.isArray(chunks)) {
    throw new Error(`script ${label} chunks must be an array`);
  }
  if (chunks.length < MIN_CHUNKS_PER_PART) {
    throw new Error(`script ${label} chunks must include at least ${MIN_CHUNKS_PER_PART} chunk(s)`);
  }

  for (const [index, chunk] of chunks.entries()) {
    const chunkLabel = `${label} chunk ${index + 1}`;
    if (typeof chunk !== "string" || chunk.trim().length === 0) {
      throw new Error(`script ${chunkLabel} must be a non-empty string`);
    }
  }
}

function stableHash(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function countChunkWords(chunks: readonly NarrationChunk[]): number {
  return chunks.reduce((sum, chunk) => sum + countWords(chunk), 0);
}

interface UrlDiff {
  missing: string[];
  extra: string[];
}

function diffNormalizedUrls(received: string[], expected: string[]): UrlDiff {
  const receivedCounts = countNormalizedUrls(received);
  const expectedCounts = countNormalizedUrls(expected);

  return {
    missing: subtractUrlCounts(expectedCounts, receivedCounts),
    extra: subtractUrlCounts(receivedCounts, expectedCounts),
  };
}

function countNormalizedUrls(urls: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const url of urls) {
    const normalized = normalizeSourceUrl(url);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

function subtractUrlCounts(
  left: Map<string, number>,
  right: Map<string, number>,
): string[] {
  const diff: string[] = [];
  for (const [url, count] of left) {
    const remaining = count - (right.get(url) ?? 0);
    for (let i = 0; i < remaining; i += 1) {
      diff.push(url);
    }
  }
  return diff.sort();
}

function normalizeSourceUrl(url: string): string {
  return url.trim();
}

function formatUrlList(urls: string[]): string {
  return urls.length === 0 ? "[]" : JSON.stringify(urls);
}

export function formatLongDate(yyyymmdd: string): string {
  const parts = yyyymmdd.split("-").map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (!y || !m || !d) return yyyymmdd;
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${months[m - 1]} ${d}, ${y}`;
}
