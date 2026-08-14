import "dotenv/config";
import { rm } from "node:fs/promises";
import { fetchAll } from "./fetch.js";
import { curate } from "./curate.js";
import { writeScript } from "./script.js";
import { earEdit, resolveEarEditEnabled } from "./earEdit.js";
import { buildRecentPhraseProfile, loadRecentStyleSnippets } from "./ledger.js";
import { synthesize } from "./tts.js";
import { buildEpisodeAudio } from "./audio.js";
import { resolveEpisodeDate } from "./episode-date.js";
import { hasPublishedEpisode, publish } from "./publish.js";
import { pingHealthcheck } from "./healthcheck.js";
import { withStageCache } from "./stageCache.js";
import { assertPreflight } from "./preflight.js";
import { logJson } from "./util.js";

async function main(): Promise<void> {
  const overallStart = Date.now();
  const date = resolveEpisodeDate();
  let workDir: string | null = null;

  try {
    logJson({ phase: "pipeline", status: "start", date });
    // Fire-and-forget: a slow/down monitor must not delay the pipeline. The
    // ping self-swallows errors; the event loop still flushes it before exit.
    void pingHealthcheck("start");

    // Backup cron / same-day re-runs: exit before paid stages when today's
    // episode is already published (sidecar + mp3 present on disk).
    if (await hasPublishedEpisode(date)) {
      logJson({
        phase: "pipeline",
        status: "skipped",
        reason: "episode_already_published",
        date,
        durationMs: Date.now() - overallStart,
      });
      void pingHealthcheck("success");
      return;
    }

    await assertPreflight();

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
    const { selected: clusters, report: curationReport } = await withStageCache(
      "curate",
      { date, articles },
      () => curate(articles, date),
    );
    if (clusters.length === 0) throw new Error("curate returned 0 clusters");
    logJson({
      phase: "pipeline.step",
      step: "curate",
      durationMs: Date.now() - curateStart,
      clusters: clusters.length,
    });

    const scriptStart = Date.now();
    // Non-blocking: [] on any failure. Both are included in the stage-cache
    // key so a change in the anti-repetition examples invalidates a cached
    // script. phraseProfile stays in scope for the ear-edit stage below.
    const recentStyle = await loadRecentStyleSnippets(date);
    const phraseProfile = await buildRecentPhraseProfile(date);
    const episode = await withStageCache(
      "script",
      { date, clusters, recentStyle, phraseProfile },
      () => writeScript(date, clusters, { recentStyle, phraseProfile }),
    );
    logJson({
      phase: "pipeline.step",
      step: "script",
      durationMs: Date.now() - scriptStart,
      segments: episode.segments.length,
    });

    // Non-blocking copy-editing pass: falls back to the unedited script on
    // any failure, so this stage can never fail the pipeline. Downstream
    // stages (tts, audio, publish) consume the possibly-edited episode —
    // the edited text becomes canonical (transcript, sidecar stance). The
    // stage-cache result carries `edited`/`edits` explicitly rather than
    // being inferred from object identity, which a cache hit (a fresh
    // JSON.parse'd object either way) would always break.
    let spokenEpisode = episode;
    if (resolveEarEditEnabled()) {
      const earEditStart = Date.now();
      const earEditResult = await withStageCache(
        "earEdit",
        {
          date,
          episode: { intro: episode.intro, segments: episode.segments, outro: episode.outro },
          notes: clusters.map((c) => ({
            headline: c.headline,
            whyItMatters: c.whyItMatters,
            caveat: c.caveat,
          })),
        },
        () => earEdit(episode, clusters, phraseProfile),
      );
      spokenEpisode = earEditResult.episode;
      logJson({
        phase: "pipeline.step",
        step: "earEdit",
        durationMs: Date.now() - earEditStart,
        segments: spokenEpisode.segments.length,
        edited: earEditResult.edited,
        edits: earEditResult.edits.length,
      });
    }

    const ttsStart = Date.now();
    const tts = await synthesize(spokenEpisode);
    workDir = tts.segmentDir;
    logJson({
      phase: "pipeline.step",
      step: "tts",
      durationMs: Date.now() - ttsStart,
      segments: tts.segmentPaths.length,
    });

    const audioStart = Date.now();
    const audio = await buildEpisodeAudio(spokenEpisode, tts.segmentPaths, workDir);
    logJson({
      phase: "pipeline.step",
      step: "audio",
      durationMs: Date.now() - audioStart,
      byteLength: audio.byteLength,
      durationSeconds: audio.durationSeconds,
    });

    const publishStart = Date.now();
    const pub = await publish(
      spokenEpisode,
      audio.finalPath,
      audio.byteLength,
      audio.durationSeconds,
      audio.partTimings,
      clusters,
      curationReport,
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
    void pingHealthcheck("success");
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
    void pingHealthcheck("fail");
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
