import { execa } from "execa";
import { isDesignedVoiceId } from "./geminiTts.js";
import { resolveTTSProviderConfig } from "./ttsProvider.js";
import { logJson } from "./util.js";

export type PreflightStatus = "ok" | "error";

export interface PreflightCheck {
  name: string;
  status: PreflightStatus;
  message?: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

export interface PreflightOptions {
  env?: NodeJS.ProcessEnv;
  /** Voice from config/show.json, so a designed voice id selects the Gemini route. */
  fileVoice?: string;
  commandExists?: (command: string) => Promise<boolean>;
}

const REQUIRED_BINARIES = ["ffmpeg", "ffprobe"] as const;

export function buildEnvironmentPreflightChecks(
  env: NodeJS.ProcessEnv = process.env,
  fileVoice?: string,
): PreflightCheck[] {
  const checks: PreflightCheck[] = [
    requireEnv(env, "OPENROUTER_API_KEY", "required for curation"),
  ];

  const ttsConfig = resolveTTSProviderConfig(env, fileVoice);
  checks.push(
    requireEnv(
      env,
      ttsConfig.apiKeyEnvVar,
      `required for ${ttsConfig.provider} TTS`,
    ),
  );
  const override = designedVoiceOverride(env, fileVoice);
  if (override) checks.push(override);
  checks.push(validateFeedBaseUrl(env.FEED_BASE_URL));

  return dedupeChecks(checks);
}

export async function runPreflight(
  opts: PreflightOptions = {},
): Promise<PreflightResult> {
  const env = opts.env ?? process.env;
  const commandExists = opts.commandExists ?? defaultCommandExists;
  const runtimeChecks = await Promise.all(
    REQUIRED_BINARIES.map(async (command) => ({
      name: command,
      ...(await commandExists(command)
        ? { status: "ok" as const }
        : {
            status: "error" as const,
            message: `${command} must be installed and available on PATH`,
          }),
    })),
  );
  const checks = [...buildEnvironmentPreflightChecks(env, opts.fileVoice), ...runtimeChecks];

  return {
    ok: checks.every((check) => check.status === "ok"),
    checks,
  };
}

export async function assertPreflight(
  opts: PreflightOptions = {},
): Promise<void> {
  const result = await runPreflight(opts);
  logJson({
    phase: "preflight",
    status: result.ok ? "ok" : "error",
    checks: result.checks,
  });

  if (!result.ok) {
    throw new Error(formatPreflightFailure(result));
  }
}

export function formatPreflightFailure(result: PreflightResult): string {
  const failures = result.checks.filter((check) => check.status === "error");
  return [
    "Pipeline preflight failed:",
    ...failures.map((check) => `- ${check.name}: ${check.message ?? "failed"}`),
  ].join("\n");
}

function requireEnv(
  env: NodeJS.ProcessEnv,
  name: "OPENROUTER_API_KEY" | "OPENAI_API_KEY" | "GEMINI_API_KEY",
  reason: string,
): PreflightCheck {
  return isNonBlank(env[name])
    ? { name, status: "ok" }
    : { name, status: "error", message: `${name} is not set (${reason})` };
}

function validateFeedBaseUrl(raw: string | undefined): PreflightCheck {
  const name = "FEED_BASE_URL";
  const value = raw?.trim();
  if (!value) {
    return {
      name,
      status: "error",
      message: "FEED_BASE_URL is not set (required for podcast enclosure URLs)",
    };
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        name,
        status: "error",
        message: "FEED_BASE_URL must start with http:// or https://",
      };
    }
  } catch {
    return {
      name,
      status: "error",
      message: "FEED_BASE_URL must be an absolute http(s) URL",
    };
  }

  return { name, status: "ok" };
}

function dedupeChecks(checks: PreflightCheck[]): PreflightCheck[] {
  const merged = new Map<string, PreflightCheck>();
  for (const check of checks) {
    const existing = merged.get(check.name);
    if (!existing || existing.status === "ok") {
      merged.set(check.name, check);
    }
  }
  return [...merged.values()];
}

async function defaultCommandExists(command: string): Promise<boolean> {
  try {
    await execa(command, ["-version"], { stdout: "ignore", stderr: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isNonBlank(value: string | undefined): boolean {
  return value?.trim().length ? true : false;
}

/**
 * A designed voice in show config is the listener's choice. An Actions
 * variable that would silently drop it fails preflight instead of airing
 * the wrong voice.
 */
function designedVoiceOverride(
  env: NodeJS.ProcessEnv,
  fileVoice: string | undefined,
): PreflightCheck | undefined {
  const file = fileVoice?.trim() ?? "";
  if (!isDesignedVoiceId(file)) return undefined;

  const fromEnv = env.TTS_VOICE?.trim();
  if (fromEnv && fromEnv !== file) {
    return {
      name: "TTS_VOICE",
      status: "error",
      message: `TTS_VOICE=${fromEnv} overrides the Gemini voice ${file} in config/show.json. Clear TTS_VOICE so the designed voice is used.`,
    };
  }

  const provider = env.TTS_PROVIDER?.trim().toLowerCase();
  if (provider === "openai" || provider === "openrouter") {
    return {
      name: "TTS_PROVIDER",
      status: "error",
      message: `TTS_PROVIDER=${provider} cannot speak the Gemini voice ${file} in config/show.json. Clear TTS_PROVIDER or set it to gemini.`,
    };
  }

  return undefined;
}
