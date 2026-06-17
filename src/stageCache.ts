import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { logJson } from "./util.js";

/**
 * Content-hash stage cache (M6) — LOCAL re-run optimization.
 *
 * The pipeline runs fetch → curate → script → tts → audio → publish. When a
 * late stage fails (e.g. a publish-time git race), re-running locally otherwise
 * re-pays for the expensive LLM stages. This caches a stage's output keyed by a
 * content hash of its input: a re-run with identical input reuses the stored
 * output instead of recomputing — so you reproduce the exact episode you were
 * trying to publish without re-rolling (or re-paying for) curation/script.
 *
 * Enabled only when STAGE_CACHE_DIR is set (local dev). Unset = fully disabled,
 * so production / CI behavior is byte-identical to before. NOTE: this is a
 * single-machine cache; the daily GitHub Actions run uses a fresh runner with
 * no persistent disk, so CI re-runs are unaffected — making CI re-runs skip
 * paid stages would need actions/cache integration (a CI change), tracked as a
 * follow-up.
 */

export function stageCacheDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.STAGE_CACHE_DIR?.trim();
  return raw ? raw : undefined;
}

/** Stable content hash of a stage's name + input. */
export function cacheKey(stage: string, input: unknown): string {
  const hash = createHash("sha256");
  // Update incrementally to avoid allocating a combined copy of the JSON payload.
  hash.update(stage);
  hash.update(":");
  hash.update(JSON.stringify(input));
  return hash.digest("hex").slice(0, 32);
}

export interface StageCacheOptions {
  /** Cache directory; defaults to stageCacheDir(). Undefined disables caching. */
  dir?: string;
}

/**
 * Run `compute`, caching its (JSON-serializable) result keyed by `input`.
 * No-op passthrough when caching is disabled. Cache read/write errors are
 * non-fatal — on any cache problem the stage simply computes normally.
 */
export async function withStageCache<T>(
  stage: string,
  input: unknown,
  compute: () => Promise<T>,
  opts: StageCacheOptions = {},
): Promise<T> {
  const dir = opts.dir ?? stageCacheDir();
  if (!dir) return compute(); // caching disabled — identical to no cache

  const key = cacheKey(stage, input);
  const file = path.join(dir, `${stage}-${key}.json`);

  try {
    const cached = await readFile(file, "utf8");
    logJson({ phase: "stage-cache", stage, status: "hit" });
    return JSON.parse(cached) as T;
  } catch {
    // miss (or unreadable/corrupt) — compute fresh below
  }

  const result = await compute();

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(result), "utf8");
    logJson({ phase: "stage-cache", stage, status: "store" });
  } catch (err) {
    // Non-fatal: a cache write failure must not break the pipeline.
    logJson({
      phase: "stage-cache",
      stage,
      status: "warn",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}
