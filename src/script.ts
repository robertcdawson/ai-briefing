import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { buildInlineAudioTagRules } from "./audioTags.js";
import { normalizeForNgrams } from "./ngrams.js";
import { resolveTTSProviderConfig } from "./ttsProvider.js";
import { getStoryCategoryLabel, STORY_CATEGORY_DEFINITIONS } from "./types.js";
import type { Episode, NarrationChunk, StoryCluster } from "./types.js";
import type { RecentPhraseProfile, RecentStyleSnippets } from "./ledger.js";
import { PHRASE_PROFILE_WINDOW, PHRASE_REJECT_MIN_EPISODES } from "./ledger.js";
import type { ChatCompletionLike } from "./util.js";
import { getChatCompletionAssistantText, logJson, withHardTimeout, withRetry } from "./util.js";
import { VOICE_EXEMPLARS, formatHostIdentityBlock } from "./voice.js";

// Sonnet leads for prose quality (voice adherence, wit, varied phrasing);
// the cheaper models remain as availability fallbacks. Sonnet was briefly the
// default before (removed when strict-schema minLength/pattern constraints
// broke Bedrock-routed structured output); those constraints are long gone and
// curation already runs Sonnet with strict JSON schema daily.
// gpt-4o-mini goes last: it ignores much of the voice-rule block, and the
// weakest-reading published episodes line up with days it served as fallback.
export const DEFAULT_SCRIPT_MODELS = [
  "anthropic/claude-sonnet-4.6",
  "google/gemini-3.1-pro-preview",
  "openai/gpt-4o-mini",
] as const;
const DEFAULT_SCRIPT_TIMEOUT_MS = 360_000;
const MIN_SCRIPT_TIMEOUT_MS = 60_000;
const MAX_SCRIPT_TIMEOUT_MS = 900_000;
// 3 attempts: the outro-mold validators below can reject an otherwise good
// script, and a temperature-0.7 re-roll usually clears the mold.
const SCRIPT_ATTEMPTS_PER_MODEL = 3;
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
  /** Recent episodes' intro openers / outro openers / sign-offs, injected as "do not reuse" examples. */
  recentStyle?: RecentStyleSnippets[];
  /** Recent episodes' recurring 3/4-grams (src/ledger.ts buildRecentPhraseProfile), the statistical anti-repetition tripwire. */
  phraseProfile?: RecentPhraseProfile;
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
  stance?: string | null;
}

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
        "Spoken intro as 2-3 narration chunks. Open on the day's most consequential specific — a number, a name, a concrete event — following today's opening instruction. Mention the date once, wherever it lands naturally, not always as 'It's {date}'. Do not preview the episode as a list of coming stories every day; some days, flow straight into the first story. No 'welcome to' boilerplate.",
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
              "The host's monologue for this story as several narration chunks. The listener should come away knowing what concretely happened, why it matters, and what's uncertain or overhyped — but reach those beats in whatever order and framing fits this particular story, never the same checklist twice, and never announce a beat by name (no 'the honest caveat is', 'the takeaway here is', 'worth noting'). Scale depth to the story's importance; end with a short, specific transition.",
          },
          sourceUrls: {
            type: "array",
            items: { type: "string" },
          },
          stance: {
            type: ["string", "null"],
            description:
              "One sentence, 25 words max, first person: the judgment or prediction you committed to on air for this story. Null if the segment is purely factual with no committed take.",
          },
        },
        required: ["title", "chunks", "sourceUrls", "stance"],
        additionalProperties: false,
      },
    },
    outro: {
      type: "array",
      items: NARRATION_CHUNK_SCHEMA,
      description:
        "Closing 2-4 narration chunks. Follow today's closing instruction for the ending's shape. Do not re-list the day's stories one by one, and do not open by 'pulling back' or 'stepping back' to find a pattern across them. Finish with one short sign-off in the host's voice that does not reuse any recently used construction.",
    },
  },
  required: ["intro", "segments", "outro"],
  additionalProperties: false,
} as const;

const SEGMENT_LABEL_RULES = STORY_CATEGORY_DEFINITIONS
  .map((category) => `  - ${category.id}: "${category.label}: {headline}"`)
  .join("\n");

// FROZEN: do not add entries here. This list is only for timeless podcast
// filler that reads as stale in any era; statistical drift in what this show
// actually repeats is owned by the phrase tripwire (buildRecentPhraseProfile
// in src/ledger.ts + assertNoWornPhrases below), which adapts automatically
// instead of chasing yesterday's mold with a new regex.
export const BANNED_SCRIPT_PHRASES = [
  "dive in",
  "diving in",
  "stay tuned",
  "until next time",
  "let's not forget",
  "game-changer",
  "buckle up",
  "that's a wrap",
  "the honest caveat",
  "worth noting",
  "the takeaway here",
  "a pattern emerges",
] as const;

const SPLIT_CONTRAST_NOUN_PHRASE_PATTERN = String.raw`(?:(?:just|only|merely|simply)\s+)?(?:a|an|the|another|this|that|its|their|our|your)\b`;
const SPLIT_CONTRAST_REFRAME_PATTERN = String.raw`(?:(?:actually|basically|really|just|rather|instead)\s+)?(?:a|an|the|another|this|that|its|their|our|your)\b`;
// Sentence boundary accepts ; as well as ./!/? \u2014 the mold survived as
// "That's not a hypothetical risk scenario; that's what happened".
const DISCOURAGED_SPLIT_CONTRAST_PATTERN = new RegExp(
  String.raw`\b(?:that|this|it)(?:(?:\s+is|\s*['\u2019]s)\s+not|\s+isn(?:'|\u2019)t)\s+${SPLIT_CONTRAST_NOUN_PHRASE_PATTERN}[^.!?;]{0,160}(?:[.!?]\s+|;\s*)(?:it|that|this)(?:\s+is|\s*['\u2019]s)\s+${SPLIT_CONTRAST_REFRAME_PATTERN}`,
  "iu",
);

// Hard-fail molds scoped to the outro, where every published mold lived and a
// false positive is near-impossible. Rule of thumb: never hard-fail on a
// construction the prompt does not explicitly forbid \u2014 every regex here must
// have a mirror sentence in the CLOSING/sign-off rules so a compliant model
// can't hit it.
const BANNED_OUTRO_OPENER_PATTERN = /^(?:pull|step|zoom)\s+back\b/i;
const BANNED_OUTRO_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern:
      /\b(?:a|one)(?:\s+single)?\s+(?:pattern|theme|thread|tension|through-?line|frequency)\s+(?:emerges|jumps out|comes through|runs through)\b/i,
    reason: `"a pattern emerges" synthesis mold`,
  },
  {
    pattern: /\bkeep your\s+\w+(?:\s+\w+){0,4}\s+and your\b/i,
    reason: `"Keep your X and your Y" sign-off mold`,
  },
  {
    pattern:
      /\bthat['\u2019]?s\s+(?:the|your|today['\u2019]?s)\s+(?:bulletin|signal|briefing|dispatch|broadcast|transmission|frequency|file)\b/i,
    reason: `"That's the {bulletin} for {date}" sign-off mold`,
  },
  {
    pattern: /\bthe gap between\b/i,
    reason: `"the gap between" outro framing mold`,
  },
];

// Deterministic per-day shape rotation for the opening and closing. "Write a
// fresh outro every day" reliably collapses into one mold; prescribing a
// different structural move per day does not.
export const INTRO_MOVES = [
  "Cold-open inside the lead story: start with its single most striking concrete detail \u2014 no date, no episode preview \u2014 and work the date in a chunk or two later.",
  "Open with the day's sharpest number or quote, put the date in the same breath, then move straight into the first story without previewing the rest of the episode.",
  "Open by connecting today's lead story to a bigger shift already underway, mention the date in passing, and preview at most ONE other story \u2014 never a list of everything coming.",
] as const;

export const OUTRO_MOVES = [
  "Stay inside the final story: land its implication, then sign off. No cross-story synthesis today.",
  "Close on the single concrete thing to watch next \u2014 a date, a decision, a number that's coming \u2014 then sign off.",
  "Close with one genuine connection between exactly TWO of today's stories, in one or two sentences, then sign off.",
  "Close on the day's sharpest unanswered question \u2014 the thing nobody in these stories has explained \u2014 then sign off.",
] as const;

export function selectIntroMove(date: string): string {
  return INTRO_MOVES[stableHash(`${date}:intro-move`) % INTRO_MOVES.length] as string;
}

export function selectOutroMove(date: string): string {
  return OUTRO_MOVES[stableHash(`${date}:outro-move`) % OUTRO_MOVES.length] as string;
}

// Extends the intro/outro MOVES mechanism into the segment bodies, where
// most of the episode's words actually live. Each story gets a deterministic
// shape independent of the others, so adjacent segments in the same episode
// read differently and the show doesn't fall into a single template.
export const SEGMENT_SHAPES: readonly { name: string; instruction: string }[] = [
  {
    name: "verdict-first",
    instruction: "Open on your judgment about this story, then earn it with the evidence.",
  },
  {
    name: "mystery-first",
    instruction: "Open on the detail that doesn't add up; resolve it, or leave it honestly open.",
  },
  {
    name: "listener-objection",
    instruction: "Open by voicing the smart listener's pushback on this story, then answer it.",
  },
  {
    name: "how-we-got-here",
    instruction: "Give a compressed timeline that makes today's development the inevitable next line.",
  },
  {
    name: "follow-the-money",
    instruction: "Start from who pays and who collects, and read the announcement through the incentives.",
  },
  {
    name: "builder-impact-first",
    instruction: "Open with what changes Monday morning for someone building on this, then widen out.",
  },
] as const;

export function selectSegmentShape(date: string, segmentIndex: number): { name: string; instruction: string } {
  const shape = SEGMENT_SHAPES[
    (stableHash(`${date}:segment-shapes`) + segmentIndex) % SEGMENT_SHAPES.length
  ];
  if (!shape) throw new Error("No segment shapes configured");
  return shape;
}

function buildSystemPromptBase(allowAudioTags: boolean): string {
  const chunkPurityRule = allowAudioTags
    ? "- Do not include speaker labels, stage directions, reactions, fake laughter, or audio cues. The ONLY bracketed text allowed is the approved inline delivery tags described below."
    : "- Do not include speaker labels, stage directions, reactions, fake laughter, audio cues, or bracketed pauses.";
  const noMarkupRule = allowAudioTags
    ? `- No bullet points, no markdown, no stage directions, no "[pause]" cues. Approved inline delivery tags are the only exception.`
    : `- No bullet points, no markdown, no stage directions, no "[pause]" cues.`;
  const audioTagSection = allowAudioTags ? `\n\n${buildInlineAudioTagRules()}` : "";

  return `You are the writer for a daily AI news podcast called "AI Briefing", delivered by a single host speaking solo. Write a tight, natural, conversational monologue. Match this structure exactly:

- INTRO (2-3 narration chunks): Begin with an engaging hook built on the single most surprising or consequential fact of the day, shaped by today's opening instruction in the user message. Mention the date once, wherever it lands naturally — do not open every episode with "It's {date}" followed by a list of coming stories. Not a vague teaser question, and not a dry table of contents.
- STORY SEGMENTS: Write exactly one segment per provided story cluster, in the order provided (most important first). For each story, cover (in whatever order feels natural) what concretely happened, why it matters for AI builders and researchers with a listener-oriented takeaway, a plain-English gloss of any jargon on first use, the potential impact both good and bad, and an honest caveat about what's uncertain, missing, or overhyped. End each segment with a smooth, short, specific transition into the next story (or, for the last segment, into the outro).
  - FOLLOW-UP STORIES: When a story cluster is marked as a follow-up (it includes a "Previously" line with prior framing), open that segment as a continuation, not a fresh introduction. Reference how the situation has developed since the prior coverage — e.g. "the rumor we flagged Monday is now confirmed", "what started as a proposal has become policy". Do NOT re-introduce the topic as if the listener has never heard of it. New stories (no "Previously" line) are introduced normally. When the "Previously" line includes your prior take, revisit that call explicitly — say in fresh wording whether it held up, was wrong, or is still open.
  - CONFIDENCE AND SOURCING: Calibrate how firmly you state each story to its corroboration (each cluster includes a "Corroboration: N independent source(s)" line). A single-source story must be voiced as tentative and attributed — "one outlet reports", "this isn't confirmed yet" — never as established fact. When several independent sources corroborate a story, you can state its core facts plainly. When a story reads as vendor hype or an unverified claim, name that skepticism briefly rather than relaying it credulously. Do NOT over-hedge well-corroborated facts — calibration cuts both ways.
  - Do NOT use the same beat order in every segment. Vary how each story unfolds so the episode doesn't read as a template.
  - Each story in the user message carries an assigned shape; reach the essentials — what happened, why it matters, what's uncertain — through that shape, and never announce a shape or beat by name.
- CLOSING (2-4 narration chunks): Shape the ending with today's closing instruction in the user message. Never open the closing by "pulling back" or "stepping back" to find a pattern, never announce that a pattern, theme, or thread "emerges" or "runs through" the stories, never lean on "the gap between X and Y" framing, and never re-list the day's stories as a parallel run of one-clause sentences. End with a short sign-off in the host's voice.

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

${formatHostIdentityBlock()}

${formatVoiceExemplarsBlock()}

EMPHASIS BUDGET
- Baseline register is flat, declarative, and specific — most sentences should simply state what happened.
- Spend ONE deliberate rhetorical peak per episode, placed at the day's most consequential story; everywhere else, let the facts carry the weight.
- At most one analogy per episode, and only when it maps to something the listener has actually lived through. Do not reach for one every segment.
- Rhetorical questions and antitheses are allowed, but never as a run of consecutive-sentence patterns — if two sentences in a row share a shape, break one of them.

FATAL
- Avoid split contrast reversals such as "That's not X. It's Y.", "This isn't X. It's Y.", or "It is not X. It is Y." If a contrast is useful, make it one precise sentence or choose a different rhetorical turn.
- No "Welcome to" or "Today on AI Briefing" boilerplate openings, which go stale fast.
- Never invent facts, quotes, scenes, sound effects, audio cues, or source details to fit the moment.
- The sign-off must be one short line in the host's voice, different every episode. Never build it as "Keep your X and your Y" in any wording, and never precede it with "That's the {bulletin/signal/briefing/dispatch/file} for {date}". Never a stock farewell.
- If the user message lists RECENTLY USED constructions or worn-out phrasing, never use any of them word-for-word or lightly reworded — a script that reuses one is rejected and rewritten.
- Never announce a beat by name (no "the honest caveat is", "the takeaway here is", "worth noting").
- BANNED PHRASES. Never say any of these, in any tense or close variation: ${BANNED_SCRIPT_PHRASES.map((phrase) => `"${phrase}"`).join(", ")}. They are worn-out podcast filler; find specific language instead.

SPOKEN-DELIVERY MECHANICS
- Use contractions; sound like a smart person talking through the news, not reading a bulletin.
- Read-aloud-friendly: short sentences, no parenthetical asides, no stage-direction punctuation; avoid em-dashes that force awkward pauses.
- Ground every story in the concrete: each segment must carry at least one specific number, named person or organization, or short direct quote drawn from the provided material. Specifics beat adjectives.
- Explain jargon only when it helps: define specialized terms in 8-14 plain words and keep moving.
- Transitions must be one sentence, under about 12 words, and specific to the next story. Vary them, and avoid formulaic phrases like "next up", "now, onto our next story", or "now, let's turn to".
${noMarkupRule}
- Numbers in spoken form when natural ("about three billion" not "3,000,000,000").
- Don't read URLs aloud.

Each segment's sourceUrls MUST be exactly the urls provided for that cluster. Do not invent or omit any.

Return only JSON matching the provided schema.${audioTagSection}`;
}

function formatVoiceExemplarsBlock(): string {
  const quoted = VOICE_EXEMPLARS.map((exemplar) => `"${exemplar}"`).join("\n\n");
  return `REGISTER EXEMPLARS
These passages are the show at its best. Match their register — the flatness, the specificity, the way a judgment lands without being announced — never their wording:

${quoted}`;
}

export interface ScriptPromptOptions {
  /** Permit approved inline delivery tags (expressive TTS models only). */
  allowAudioTags?: boolean;
  /** Recent episodes' style snippets to list under RECENTLY USED in the user prompt. */
  recentStyle?: RecentStyleSnippets[];
  /** Recent episodes' recurring 3/4-grams, listed under RECENTLY USED as worn-out phrasing. */
  phraseProfile?: RecentPhraseProfile;
}

export function buildSystemPrompt(options: ScriptPromptOptions = {}): string {
  return buildSystemPromptBase(options.allowAudioTags === true);
}

function formatRecentStyleBlock(
  recentStyle: RecentStyleSnippets[] | undefined,
  phraseProfile: RecentPhraseProfile | undefined,
): string {
  const hasSnippets = !!recentStyle && recentStyle.length > 0;
  const hasPhrases = !!phraseProfile && phraseProfile.length > 0;
  if (!hasSnippets && !hasPhrases) return "";

  const bullet = (snippet: string, episodeDate: string): string =>
    `- (${episodeDate}) "${snippet}"`;
  const sections: string[] = [];

  if (hasSnippets) {
    const introOpeners = recentStyle!.filter((s) => s.introOpener);
    const outroOpeners = recentStyle!.filter((s) => s.outroOpener);
    const signOffs = recentStyle!.filter((s) => s.signOff);
    if (introOpeners.length > 0) {
      sections.push(
        `Intro openers:\n${introOpeners.map((s) => bullet(s.introOpener, s.episodeDate)).join("\n")}`,
      );
    }
    if (outroOpeners.length > 0) {
      sections.push(
        `Closing openers:\n${outroOpeners.map((s) => bullet(s.outroOpener, s.episodeDate)).join("\n")}`,
      );
    }
    if (signOffs.length > 0) {
      sections.push(
        `Sign-offs:\n${signOffs.map((s) => bullet(s.signOff, s.episodeDate)).join("\n")}`,
      );
    }
  }

  if (hasPhrases) {
    const phraseLines = phraseProfile!
      .map((p) => `- "${p.gram}" (${p.episodeCount} episodes)`)
      .join("\n");
    sections.push(
      `Worn-out phrasing (appeared in several of the last ${PHRASE_PROFILE_WINDOW} episodes) — never use these word-for-word or lightly reworded:\n${phraseLines}`,
    );
  }

  if (sections.length === 0) return "";
  return `\n\nRECENTLY USED (recent episodes) — these constructions are worn out. Do not reuse or lightly rephrase any of them; find a genuinely different shape for today's opening, closing, and sign-off:\n\n${sections.join("\n\n")}`;
}

export function buildUserPrompt(
  date: string,
  clusters: StoryCluster[],
  recentStyle?: RecentStyleSnippets[],
  phraseProfile?: RecentPhraseProfile,
): string {
  const lines = clusters.map((c, i) => {
    const sources = c.sources.map((s) => `${s.publisher}: ${s.url}`).join("\n      ");
    const categoryLabel = getStoryCategoryLabel(c.category);
    const importance = typeof c.importance === "number" ? `${Math.round(c.importance)}/100` : "unscored";
    const sourceCount = c.sources.length;
    const corroboration =
      sourceCount === 0
        ? "none listed (treat as unverified)"
        : `${sourceCount} independent source${sourceCount === 1 ? "" : "s"}`;
    const priorStanceSuffix = c.followUp?.priorStance
      ? ` Your prior take: "${c.followUp.priorStance.replace(/\s+/g, " ").trim()}"`
      : "";
    const followUpLine = c.followUp
      ? `\n  Previously (${c.followUp.priorDate.replace(/\s+/g, " ").trim()}): ${c.followUp.priorFraming.replace(/\s+/g, " ").trim()} — this is a FOLLOW-UP/update, not a new story.${priorStanceSuffix}`
      : "";
    const shape = selectSegmentShape(date, i);
    return `STORY ${i + 1}: ${c.headline}
  Category: ${categoryLabel} (${c.category})
  Importance: ${importance}
  Corroboration: ${corroboration}
  Shape this segment as: ${shape.name} — ${shape.instruction}
  Why it matters: ${c.whyItMatters}
  Caveat: ${c.caveat}${followUpLine}
  Sources:
      ${sources}`;
  });
  return `Today is ${date}. Write the podcast script for the following ${clusters.length} story cluster${clusters.length === 1 ? "" : "s"}, in priority order (most important first). Return exactly ${clusters.length} segment object${clusters.length === 1 ? "" : "s"}; never invent or pad. Spend more time on the higher-importance stories and explain them in adequate detail; keep lower-importance stories brief. Keep the whole episode under about ten minutes.

Today's opening instruction: ${selectIntroMove(date)}
Today's closing instruction: ${selectOutroMove(date)}

${lines.join("\n\n")}${formatRecentStyleBlock(recentStyle, phraseProfile)}`;
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
  const models = resolveScriptModels(process.env.OPENROUTER_SCRIPT_MODEL);
  const timeoutMs = resolveScriptTimeoutMs(process.env.OPENROUTER_SCRIPT_TIMEOUT_MS);
  // Inline delivery tags are only written when the configured TTS model will
  // interpret them; otherwise the script stays plain text.
  const promptOptions: ScriptPromptOptions = {
    allowAudioTags: resolveTTSProviderConfig().supportsInlineAudioTags,
    recentStyle: options.recentStyle,
    phraseProfile: options.phraseProfile,
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
              buildScriptCompletionParams(model, date, clusters, promptOptions),
            ),
            timeoutMs,
            `script.openrouter.${model}`,
          );

          const content = getChatCompletionAssistantText(completion, "OpenRouter script");

          const response = JSON.parse(content) as ScriptResponse;
          normalizeScriptResponse(response);
          const repairedSegments = reconcileScriptSourceUrls(response, clusters);
          if (repairedSegments > 0) {
            logJson({
              phase: "script.source_urls_repair",
              status: "ok",
              repairedSegments,
            });
          }
          validateScriptResponse(response, clusters);
          assertNoWornPhrases(response, options.phraseProfile ?? []);
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
    // normalizeScriptResponse already stripped null stance to undefined at
    // runtime; this map only reconciles that with EpisodeSegment's stricter
    // (non-nullable) type.
    segments: parsed.segments.map((s) => ({
      title: s.title,
      chunks: s.chunks,
      sourceUrls: s.sourceUrls,
      stance: s.stance ?? undefined,
    })),
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
  date: string,
  clusters: StoryCluster[],
  promptOptions: ScriptPromptOptions = {},
): ScriptCompletionParams {
  return {
    model,
    messages: [
      { role: "system", content: buildSystemPrompt(promptOptions) },
      {
        role: "user",
        content: buildUserPrompt(date, clusters, promptOptions.recentStyle, promptOptions.phraseProfile),
      },
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

/**
 * Normalizes nullable per-segment fields in place: null or blank becomes
 * absent (deleted), a non-blank string is trimmed. A malformed non-string,
 * non-null value is left untouched so validateScriptResponse can reject it
 * explicitly with a clear error instead of this function silently coercing
 * or swallowing it. Called immediately after JSON.parse, before reconcile
 * and validation.
 */
export function normalizeScriptResponse(response: ScriptResponse): void {
  for (const segment of response.segments) {
    normalizeNullableSegmentField(segment, "stance");
  }
}

function normalizeNullableSegmentField(
  segment: ScriptSegmentResponse,
  key: "stance",
): void {
  const value = segment[key];
  if (value === null || value === undefined) {
    delete segment[key];
    return;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      delete segment[key];
    } else {
      segment[key] = trimmed;
    }
  }
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
  validateOutroStyle(response.outro);

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
    if (segment.stance !== undefined && typeof segment.stance !== "string") {
      throw new Error(`script segment ${i + 1} stance must be a string when present`);
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

  const readAloudText = chunks.join(" ");
  if (DISCOURAGED_SPLIT_CONTRAST_PATTERN.test(readAloudText)) {
    throw new Error(
      `script ${label} uses discouraged split contrast phrasing; ` +
        `rewrite contrasts without "That's not X. It's Y." construction`,
    );
  }
}

function validateOutroStyle(chunks: readonly NarrationChunk[]): void {
  const firstChunk = chunks[0]?.trim() ?? "";
  if (BANNED_OUTRO_OPENER_PATTERN.test(firstChunk)) {
    throw new Error(
      `script outro opens with a banned "pull back / step back" construction; ` +
        `follow the closing instruction instead of a cross-story synthesis opener`,
    );
  }
  const readAloudText = chunks.join(" ");
  for (const { pattern, reason } of BANNED_OUTRO_PATTERNS) {
    if (pattern.test(readAloudText)) {
      throw new Error(`script outro uses a banned recurring construction (${reason})`);
    }
  }
}

/**
 * Statistical anti-repetition hard-fail: rejects the script if it reuses a
 * gram (word-for-word) that appeared in enough recent episodes to have
 * become a mold (>= PHRASE_REJECT_MIN_EPISODES). Mirrors the "worn-out
 * phrasing" prompt sentence in buildSystemPromptBase's Voice rules — a
 * compliant model shouldn't hit this, but a re-roll clears it when one does.
 */
export function assertNoWornPhrases(response: ScriptResponse, profile: RecentPhraseProfile): void {
  if (!profile || profile.length === 0) return;

  const readAloudText = [
    ...response.intro,
    ...response.segments.flatMap((segment) => segment.chunks),
    ...response.outro,
  ].join(" ");
  const normalized = ` ${normalizeForNgrams(readAloudText)} `;

  const offenders: string[] = [];
  for (const { gram, episodeCount } of profile) {
    if (episodeCount < PHRASE_REJECT_MIN_EPISODES) continue;
    if (normalized.includes(` ${gram} `)) {
      offenders.push(gram);
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `script reuses worn-out phrasing from recent episodes: ${offenders.map((g) => `"${g}"`).join(", ")}`,
    );
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
