import OpenAI from "openai";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Episode } from "./types.js";
import { logJson, withHardTimeout, withRetry } from "./util.js";

const MODEL = "tts-1-hd";
const TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

type TTSVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
const VALID_VOICES: TTSVoice[] = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

export interface TTSResult {
  segmentDir: string;
  segmentPaths: string[];
}

export async function synthesize(episode: Episode): Promise<TTSResult> {
  const started = Date.now();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const requestedVoice = (process.env.TTS_VOICE ?? "onyx") as TTSVoice;
  const voice: TTSVoice = VALID_VOICES.includes(requestedVoice) ? requestedVoice : "onyx";

  const client = new OpenAI({ apiKey, timeout: TIMEOUT_MS });

  const segmentDir = path.join(tmpdir(), `ai-briefing-${episode.date}-${process.pid}`);
  await mkdir(segmentDir, { recursive: true });

  const parts: { label: string; text: string }[] = [
    { label: "00-intro", text: episode.intro },
    ...episode.segments.map((s, i) => ({
      label: `${pad2(i + 1)}-${slug(s.title)}`,
      text: s.script,
    })),
    { label: `${pad2(episode.segments.length + 1)}-outro`, text: episode.outro },
  ];

  const segmentPaths: string[] = [];
  for (const part of parts) {
    const partStart = Date.now();
    const filePath = path.join(segmentDir, `${part.label}.mp3`);
    await withRetry(
      () =>
        withHardTimeout(
          (async () => {
            const response = await client.audio.speech.create({
              model: MODEL,
              voice,
              input: part.text,
              response_format: "mp3",
            });
            const buffer = Buffer.from(await response.arrayBuffer());
            await writeFile(filePath, buffer);
          })(),
          TIMEOUT_MS,
          `tts.${part.label}`,
        ),
      { attempts: MAX_ATTEMPTS, label: `tts:${part.label}` },
    );
    segmentPaths.push(filePath);
    logJson({
      phase: "tts",
      label: part.label,
      status: "ok",
      durationMs: Date.now() - partStart,
      chars: part.text.length,
    });
  }

  logJson({
    phase: "tts",
    status: "ok",
    durationMs: Date.now() - started,
    segments: segmentPaths.length,
    voice,
  });

  return { segmentDir, segmentPaths };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "segment";
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
