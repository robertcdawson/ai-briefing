import "dotenv/config";
import { rm } from "node:fs/promises";
import { fetchAll } from "./fetch.js";
import { curate } from "./curate.js";
import { writeScript } from "./script.js";
import { synthesize } from "./tts.js";
import { buildEpisodeAudio } from "./audio.js";
import { publish } from "./publish.js";
import { logJson } from "./util.js";

async function main(): Promise<void> {
  const overallStart = Date.now();
  const date = new Date().toISOString().slice(0, 10);
  let workDir: string | null = null;

  try {
    logJson({ phase: "pipeline", status: "start", date });

    const fetchStart = Date.now();
    const articles = await fetchAll();
    if (articles.length === 0) throw new Error("fetch returned 0 articles");
    logJson({
      phase: "pipeline.step",
      step: "fetch",
      durationMs: Date.now() - fetchStart,
      articles: articles.length,
    });

    const curateStart = Date.now();
    const clusters = await curate(articles);
    if (clusters.length === 0) throw new Error("curate returned 0 clusters");
    logJson({
      phase: "pipeline.step",
      step: "curate",
      durationMs: Date.now() - curateStart,
      clusters: clusters.length,
    });

    const scriptStart = Date.now();
    const episode = await writeScript(date, clusters);
    logJson({
      phase: "pipeline.step",
      step: "script",
      durationMs: Date.now() - scriptStart,
      segments: episode.segments.length,
    });

    const ttsStart = Date.now();
    const tts = await synthesize(episode);
    workDir = tts.segmentDir;
    logJson({
      phase: "pipeline.step",
      step: "tts",
      durationMs: Date.now() - ttsStart,
      segments: tts.segmentPaths.length,
    });

    const audioStart = Date.now();
    const audio = await buildEpisodeAudio(episode, tts.segmentPaths, workDir);
    logJson({
      phase: "pipeline.step",
      step: "audio",
      durationMs: Date.now() - audioStart,
      byteLength: audio.byteLength,
      durationSeconds: audio.durationSeconds,
    });

    const publishStart = Date.now();
    const pub = await publish(
      episode,
      audio.finalPath,
      audio.byteLength,
      audio.durationSeconds,
    );
    logJson({
      phase: "pipeline.step",
      step: "publish",
      durationMs: Date.now() - publishStart,
      episodePath: pub.episodePath,
      feedItemCount: pub.feedItemCount,
    });

    logJson({
      phase: "pipeline",
      status: "ok",
      durationMs: Date.now() - overallStart,
      date,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logJson({
      phase: "pipeline",
      status: "error",
      durationMs: Date.now() - overallStart,
      error: message,
      stack,
    });
    process.exitCode = 1;
  } finally {
    if (workDir) {
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

await main();
