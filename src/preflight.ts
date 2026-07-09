import { execa } from "execa";
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
  commandExists?: (command: string) => Promise<boolean>;
}

const REQUIRED_BINARIES = ["ffmpeg", "ffprobe"] as const;

export function buildEnvironmentPreflightChecks(
  env: NodeJS.ProcessEnv = process.env,
): PreflightCheck[] {
  const checks: PreflightCheck[] = [
    requireEnv(env, "OPENROUTER_API_KEY", "required for curation"),
  ];

  const ttsConfig = resolveTTSProviderConfig(env);
  checks.push(
    requireEnv(
      env,
      ttsConfig.apiKeyEnvVar,
      `required for ${ttsConfig.provider} TTS`,
    ),
  );
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
  const checks = [...buildEnvironmentPreflightChecks(env), ...runtimeChecks];

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
  name: "OPENROUTER_API_KEY" | "OPENAI_API_KEY",
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
