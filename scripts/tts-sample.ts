import "dotenv/config";
import OpenAI from "openai";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildPartSpeechRequest } from "../src/tts.js";
import {
  DEFAULT_OPENAI_TTS_MODEL,
  DEFAULT_OPENROUTER_TTS_MODEL,
  OPENROUTER_TTS_BASE_URL,
  supportsOpenAIDeliveryInstructions,
  type TTSProviderConfig,
  type TTSProviderId,
} from "../src/ttsProvider.js";
import { supportsInlineAudioTags } from "../src/audioTags.js";
import { resolveTTSDirection } from "../src/speakerProfiles.js";
import { logJson } from "../src/util.js";

/**
 * A/B listening tool: synthesizes one fixed paragraph across candidate
 * provider/model/voice combinations so a default can be chosen by ear before
 * changing production config.
 *
 * Usage:
 *   npm run tts:sample                                  # built-in candidates
 *   npm run tts:sample -- openrouter:google/gemini-3.1-flash-tts-preview:Puck
 *
 * Candidates whose API key is missing are skipped with a log line.
 * Output: tmp/tts-samples/<provider>-<model>-<voice>.mp3
 */

const OUTPUT_DIR = path.join("tmp", "tts-samples");
const TIMEOUT_MS = 120_000;

const SAMPLE_CHUNKS = [
  "Anthropic shipped a new flagship model this morning, and the benchmark chart looks great, as benchmark charts always do.",
  "Here's the part worth your attention: the safety filters now block about nine percent of requests, and the price doubled.",
  "[skeptical] So before anyone rewires their stack, it's worth asking who actually benefits from this release.",
];

interface SampleCandidate {
  provider: TTSProviderId;
  model: string;
  voice: string;
}

const DEFAULT_CANDIDATES: SampleCandidate[] = [
  { provider: "openai", model: DEFAULT_OPENAI_TTS_MODEL, voice: "marin" },
  { provider: "openai", model: DEFAULT_OPENAI_TTS_MODEL, voice: "cedar" },
  { provider: "openrouter", model: DEFAULT_OPENROUTER_TTS_MODEL, voice: "Charon" },
  { provider: "openrouter", model: DEFAULT_OPENROUTER_TTS_MODEL, voice: "Enceladus" },
];

function parseCandidateArg(arg: string): SampleCandidate {
  const [provider, ...rest] = arg.split(":");
  const voice = rest.pop();
  const model = rest.join(":");
  if ((provider !== "openai" && provider !== "openrouter") || !model || !voice) {
    throw new Error(`Invalid candidate "${arg}"; expected provider:model:voice`);
  }
  return { provider, model, voice };
}

function toProviderConfig(candidate: SampleCandidate): TTSProviderConfig {
  if (candidate.provider === "openrouter") {
    return {
      provider: "openrouter",
      model: candidate.model,
      voice: candidate.voice,
      baseURL: OPENROUTER_TTS_BASE_URL,
      apiKeyEnvVar: "OPENROUTER_API_KEY",
      supportsDeliveryInstructions: false,
      supportsInlineAudioTags: supportsInlineAudioTags(candidate.model),
      maxRequestChars: 8000,
    };
  }
  return {
    provider: "openai",
    model: candidate.model,
    voice: candidate.voice,
    apiKeyEnvVar: "OPENAI_API_KEY",
    supportsDeliveryInstructions: supportsOpenAIDeliveryInstructions(candidate.model),
    supportsInlineAudioTags: false,
    maxRequestChars: 4096,
  };
}

function sampleFilename(candidate: SampleCandidate): string {
  const slug = `${candidate.provider}-${candidate.model}-${candidate.voice}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug}.mp3`;
}

async function main(): Promise<void> {
  const extraCandidates = process.argv.slice(2).map(parseCandidateArg);
  const candidates = extraCandidates.length > 0 ? extraCandidates : DEFAULT_CANDIDATES;
  await mkdir(OUTPUT_DIR, { recursive: true });
  const direction = resolveTTSDirection();

  let written = 0;
  for (const candidate of candidates) {
    const config = toProviderConfig(candidate);
    const apiKey = process.env[config.apiKeyEnvVar];
    if (!apiKey) {
      logJson({
        phase: "tts.sample",
        status: "skipped",
        reason: `${config.apiKeyEnvVar} is not set`,
        provider: candidate.provider,
        model: candidate.model,
        voice: candidate.voice,
      });
      continue;
    }

    const client = new OpenAI({
      apiKey,
      baseURL: config.baseURL,
      timeout: TIMEOUT_MS,
      maxRetries: 0,
    });
    const request = buildPartSpeechRequest(SAMPLE_CHUNKS, config, "story", direction);
    const outputPath = path.join(OUTPUT_DIR, sampleFilename(candidate));
    const started = Date.now();

    try {
      const response = await client.audio.speech.create(request, { timeout: TIMEOUT_MS });
      await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
      written += 1;
      logJson({
        phase: "tts.sample",
        status: "ok",
        durationMs: Date.now() - started,
        provider: candidate.provider,
        model: candidate.model,
        voice: candidate.voice,
        outputPath,
      });
    } catch (err) {
      logJson({
        phase: "tts.sample",
        status: "error",
        provider: candidate.provider,
        model: candidate.model,
        voice: candidate.voice,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logJson({ phase: "tts.sample", status: "done", written, outputDir: OUTPUT_DIR });
}

main().catch((err) => {
  logJson({
    phase: "tts.sample",
    status: "fatal",
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
