import OpenAI from "openai";
import type { Episode, EpisodeSegment, StoryCluster } from "./types.js";
import { logJson, withHardTimeout, withRetry } from "./util.js";

const MODEL = "anthropic/claude-opus-4.7";
const TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 3;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    intro: {
      type: "string",
      description: "15-25s spoken intro hook (~40-60 words)",
    },
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          script: {
            type: "string",
            description:
              "~90s spoken script (~220-260 words): what happened → why it matters → caveat → 1-line transition into the next story (or outro for the final segment).",
          },
          sourceUrls: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["title", "script", "sourceUrls"],
        additionalProperties: false,
      },
    },
    outro: {
      type: "string",
      description:
        "30-40s synthesis outro (~80-100 words) identifying a pattern, theme, or contrast across the stories. End with a sign-off.",
    },
  },
  required: ["intro", "segments", "outro"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are the writer for a daily AI news podcast called "AI Briefing". Write a tight, conversational 4-7 minute spoken script (~600-1000 words total) for a single host. Match this structure exactly:

- INTRO HOOK (15-25 seconds, ~40-60 words): A compelling cold open that names the date and previews the day's stories. Not a dry table of contents.
- THREE SEGMENTS (~90 seconds each, ~220-260 words each), one per story cluster, in the order provided. Each segment must:
  1. Open with what happened — concrete and specific.
  2. Explain why it matters for AI builders/researchers.
  3. End with a brief caveat: what's uncertain, missing, or potentially overhyped.
  4. Close with a one-line transition into the next story (or, for the last segment, into the outro).
- SYNTHESIS OUTRO (30-40 seconds, ~80-100 words): Identify a pattern, theme, or contrast across the three stories. End with a sign-off.

Voice rules:
- Conversational and intelligent, not breathless or hyped.
- Optimize for information retention: vary sentence rhythm, front-load concrete details, and reinforce each segment's key takeaway once near the end.
- Use light, dry humor sparingly (about one quick line per segment max) when it helps recall, never at the expense of accuracy or clarity.
- Bring some attitude: sound like a sharp analyst with opinions grounded in evidence, not a neutral press-release reader.
- Read-aloud-friendly: short sentences, no parenthetical asides, avoid em-dashes that force awkward pauses.
- No "Welcome to" or "Today on AI Briefing" boilerplate openings — that gets stale fast.
- No bullet points, no markdown, no stage directions, no "[pause]" cues.
- Numbers in spoken form when natural ("about three billion" not "3,000,000,000").
- Don't read URLs aloud.

Each segment's sourceUrls MUST be exactly the urls provided for that cluster. Do not invent or omit any.

Return only JSON matching the provided schema.`;

function buildUserPrompt(date: string, clusters: StoryCluster[]): string {
  const lines = clusters.map((c, i) => {
    const sources = c.sources.map((s) => `${s.publisher}: ${s.url}`).join("\n      ");
    return `STORY ${i + 1}: ${c.headline}
  Why it matters: ${c.whyItMatters}
  Caveat: ${c.caveat}
  Sources:
      ${sources}`;
  });
  return `Today is ${date}. Write the podcast script for the following ${clusters.length} story cluster${clusters.length === 1 ? "" : "s"}, in order:

${lines.join("\n\n")}`;
}

export async function writeScript(date: string, clusters: StoryCluster[]): Promise<Episode> {
  const started = Date.now();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  if (clusters.length === 0) throw new Error("writeScript: no clusters provided");

  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    timeout: TIMEOUT_MS,
  });

  const completion = await withRetry(
    () =>
      withHardTimeout(
        client.chat.completions.create({
          model: MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(date, clusters) },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "episode_script", strict: true, schema: RESPONSE_SCHEMA },
          },
          temperature: 0.7,
        }),
        TIMEOUT_MS,
        "script.openrouter",
      ),
    { attempts: MAX_ATTEMPTS, label: "script" },
  );

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Empty response from OpenRouter");

  const parsed = JSON.parse(content) as {
    intro: string;
    segments: EpisodeSegment[];
    outro: string;
  };

  const wordCount =
    countWords(parsed.intro) +
    parsed.segments.reduce((sum, s) => sum + countWords(s.script), 0) +
    countWords(parsed.outro);

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
  });

  return episode;
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
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
