import OpenAI from "openai";
import { getEpisodeSpeakers, isSpeakerId, speakerNamesForPrompt } from "./speakers.js";
import { getStoryCategoryLabel, STORY_CATEGORY_DEFINITIONS } from "./types.js";
import type { Episode, SpeakerTurn, StoryCluster } from "./types.js";
import { logJson, withHardTimeout, withRetry } from "./util.js";

const DEFAULT_SCRIPT_MODEL = "anthropic/claude-sonnet-4.6";
const DEFAULT_SCRIPT_TIMEOUT_MS = 180_000;
const MIN_SCRIPT_TIMEOUT_MS = 60_000;
const MAX_SCRIPT_TIMEOUT_MS = 600_000;
const MAX_ATTEMPTS = 3;
const MIN_TURNS_PER_PART = 2;

export interface DailyPersona {
  name: string;
  inspiration: string;
  delivery: string;
  opinionStance: string;
  humor: string;
  avoid: string;
}

export interface ScriptResponse {
  intro: SpeakerTurn[];
  segments: ScriptSegmentResponse[];
  outro: SpeakerTurn[];
}

export interface ScriptSegmentResponse {
  title: string;
  turns: SpeakerTurn[];
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

const SPEAKER_TURN_SCHEMA = {
  type: "object",
  properties: {
    speaker: {
      type: "string",
      enum: ["anchor", "analyst"],
      description: "The speaker persona for this spoken turn.",
    },
    text: {
      type: "string",
      minLength: 1,
      pattern: "\\S",
      description: "One read-aloud-friendly spoken turn. Do not include speaker labels or stage directions.",
    },
  },
  required: ["speaker", "text"],
  additionalProperties: false,
} as const;

export const SCRIPT_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    intro: {
      type: "array",
      items: SPEAKER_TURN_SCHEMA,
      description: "15-25s spoken intro hook as 2-3 concise speaker turns (~40-70 words total).",
    },
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, pattern: "\\S" },
          turns: {
            type: "array",
            items: SPEAKER_TURN_SCHEMA,
            description:
              "~90s conversational story script as 4-7 concise turns (~220-280 words total): what happened, why it matters, brief explainer when needed, caveat, and a short transition into the next story or outro.",
          },
          sourceUrls: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["title", "turns", "sourceUrls"],
        additionalProperties: false,
      },
    },
    outro: {
      type: "array",
      items: SPEAKER_TURN_SCHEMA,
      description:
        "30-40s synthesis outro as 2-4 turns (~80-110 words total) identifying a pattern, theme, or contrast across the stories. End with a sign-off.",
    },
  },
  required: ["intro", "segments", "outro"],
  additionalProperties: false,
} as const;

const SEGMENT_LABEL_RULES = STORY_CATEGORY_DEFINITIONS
  .map((category) => `  - ${category.id}: "${category.label}: {headline}"`)
  .join("\n");

const SYSTEM_PROMPT_BASE = `You are the writer for a daily AI news podcast called "AI Briefing". Write a tight, conversational 4-7 minute spoken script (~600-1000 words total) as a two-speaker exchange. Match this structure exactly:

- INTRO HOOK (15-25 seconds, ~40-70 words total): Begin with an engaging summary hook: the day's thesis, tension, or surprise, then name the date and preview the stakes. Not a dry table of contents.
- STORY SEGMENTS (~90 seconds each, ~220-280 words each): Write exactly one segment per provided story cluster, in the order provided. If fewer than three credible clusters are provided, write fewer segments; never invent or pad. Each segment must:
  1. Open with what happened — concrete and specific.
  2. Explain why it matters for AI builders/researchers, with a listener-oriented takeaway.
  3. Briefly explain technical terms on first use in plain English, only when needed.
  4. End with a brief caveat: what's uncertain, missing, or potentially overhyped.
  5. Close with a smooth, short transition into the next story (or, for the last segment, into the outro).
- SYNTHESIS OUTRO (30-40 seconds, ~80-110 words total): Identify a pattern, theme, or contrast across the provided stories. End with a sign-off.

Speaker personas:
${speakerNamesForPrompt()}

Speaker-turn rules:
- Return structured turns using only the speaker IDs "anchor" and "analyst"; do not put speaker names inside the text.
- Use both speakers throughout the episode. The Anchor keeps sequence, facts, and caveats straight. The Analyst asks the practical "so what?" and adds one memorable analogy when useful.
- Each story should feel like a real exchange, not two monologues pasted together. Keep turns short enough for natural back-and-forth.
- Do not add stage directions, reactions, crosstalk markers, fake laughter, audio cues, or bracketed pauses.

Recurring segment labels:
- The first segment title MUST begin "Top Story: " followed by the story headline.
- Later segment titles MUST use the provided category's recurring label:
${SEGMENT_LABEL_RULES}
- Keep titles compact. Do not invent new segment label names.

Voice rules:
- Conversational and intelligent, not breathless or hyped.
- Sound alert and enthusiastic, like the speakers genuinely find the material useful, while staying skeptical and precise.
- Optimize for information retention: vary sentence rhythm, front-load concrete details, and reinforce each segment's key takeaway once near the end.
- Spoken pacing: mix crisp short sentences with medium explanatory sentences. Avoid dense clauses; keep most sentences under about 24 words.
- Use light, dry humor sparingly (about one quick line per segment max) when it helps recall, never at the expense of accuracy or clarity.
- Bring some attitude: sound like a sharp analyst with opinions grounded in evidence, not a neutral press-release reader.
- The speakers may have strong opinions, but every opinion must be grounded in the provided facts. Prefer sharp analysis over neutral summary, but never sacrifice accuracy for personality.
- Read-aloud-friendly: short sentences, no parenthetical asides, avoid em-dashes that force awkward pauses.
- Explain jargon only when it helps: define specialized terms in 8-14 plain words and keep moving.
- Transitions must be one sentence, under about 12 words, and specific to the next story. Avoid formulaic phrases like "next up."
- No "Welcome to" or "Today on AI Briefing" boilerplate openings — that gets stale fast.
- No bullet points, no markdown, no stage directions, no "[pause]" cues.
- Numbers in spoken form when natural ("about three billion" not "3,000,000,000").
- Don't read URLs aloud.

Daily persona rules:
- Use the provided daily persona as a style lens, not a character bit.
- Keep the episode recognizably "AI Briefing": accurate, useful, skeptical, and concise.
- Do not imitate real people or copyrighted characters. No celebrity impressions.
- Do not invent audio cues, accents, scenes, sound effects, facts, quotes, reactions, or source details to fit the persona or the conversation.

Each segment's sourceUrls MUST be exactly the urls provided for that cluster. Do not invent or omit any.

Return only JSON matching the provided schema.`;

export function selectDailyPersona(date: string): DailyPersona {
  const index = stableHash(date) % DAILY_PERSONAS.length;
  const persona = DAILY_PERSONAS[index];
  if (!persona) throw new Error("No daily personas configured");
  return persona;
}

export function buildSystemPrompt(persona: DailyPersona): string {
  return `${SYSTEM_PROMPT_BASE}

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
    return `STORY ${i + 1}: ${c.headline}
  Category: ${categoryLabel} (${c.category})
  Why it matters: ${c.whyItMatters}
  Caveat: ${c.caveat}
  Sources:
      ${sources}`;
  });
  return `Today is ${date}. Write the podcast script for the following ${clusters.length} story cluster${clusters.length === 1 ? "" : "s"}, in order. Return exactly ${clusters.length} segment object${clusters.length === 1 ? "" : "s"}; never invent or pad:

${lines.join("\n\n")}`;
}

export function resolveScriptModel(requestedModel: string | undefined): string {
  const model = requestedModel?.trim();
  return model && model.length > 0 ? model : DEFAULT_SCRIPT_MODEL;
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

export async function writeScript(date: string, clusters: StoryCluster[]): Promise<Episode> {
  const started = Date.now();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  if (clusters.length === 0) throw new Error("writeScript: no clusters provided");
  const persona = selectDailyPersona(date);
  const model = resolveScriptModel(process.env.OPENROUTER_SCRIPT_MODEL);
  const timeoutMs = resolveScriptTimeoutMs(process.env.OPENROUTER_SCRIPT_TIMEOUT_MS);

  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    timeout: timeoutMs,
  });

  const parsed = await withRetry(
    async () => {
      const completion = await withHardTimeout(
        client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: buildSystemPrompt(persona) },
            { role: "user", content: buildUserPrompt(date, clusters) },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "episode_script", strict: true, schema: SCRIPT_RESPONSE_SCHEMA },
          },
          temperature: 0.7,
        }),
        timeoutMs,
        "script.openrouter",
      );

      const content = completion.choices[0]?.message?.content;
      if (!content) throw new Error("Empty response from OpenRouter");

      const response = JSON.parse(content) as ScriptResponse;
      validateScriptResponse(response, clusters);
      return response;
    },
    { attempts: MAX_ATTEMPTS, label: "script" },
  );

  const wordCount =
    countTurnWords(parsed.intro) +
    parsed.segments.reduce((sum, s) => sum + countTurnWords(s.turns), 0) +
    countTurnWords(parsed.outro);

  const episode: Episode = {
    date,
    title: `AI Briefing — ${formatLongDate(date)}`,
    speakers: getEpisodeSpeakers(),
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
    model,
    timeoutMs,
  });

  return episode;
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

  validateSpeakerTurns("intro", response.intro);
  validateSpeakerTurns("outro", response.outro);

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
    validateSpeakerTurns(`segment ${i + 1}`, segment.turns);

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

function validateSpeakerTurns(label: string, turns: unknown): asserts turns is SpeakerTurn[] {
  if (!Array.isArray(turns)) {
    throw new Error(`script ${label} turns must be an array`);
  }
  if (turns.length < MIN_TURNS_PER_PART) {
    throw new Error(`script ${label} turns must include at least ${MIN_TURNS_PER_PART} turns`);
  }

  for (const [index, turn] of turns.entries()) {
    const turnLabel = `${label} turn ${index + 1}`;
    if (!turn || typeof turn !== "object") {
      throw new Error(`script ${turnLabel} must be an object`);
    }
    const candidate = turn as Partial<SpeakerTurn>;
    if (!isSpeakerId(candidate.speaker)) {
      throw new Error(`script ${turnLabel} speaker must be "anchor" or "analyst"`);
    }
    if (typeof candidate.text !== "string" || candidate.text.trim().length === 0) {
      throw new Error(`script ${turnLabel} text must be a non-empty string`);
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

function countTurnWords(turns: readonly SpeakerTurn[]): number {
  return turns.reduce((sum, turn) => sum + countWords(turn.text), 0);
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
