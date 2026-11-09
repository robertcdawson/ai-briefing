import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  airedStoryDisposition,
  cueStyleAfterAssetLookup,
  GENERATION_STEP_ORDER,
  healthcheckKindForGeneration,
  healthcheckKindForVerification,
  interestProfileText,
  nextFeedPoll,
  nextPagesRecoveryStep,
  PAGES_RECOVERY_STEP_NAMES,
  resolveInterestProfileMode,
  scriptModelStep,
  showConfigReadOutcome,
  ttsPartPlan,
} from "../src/machines.js";
import { renderTuneSessionModule } from "../scripts/emit-tune-session.js";
import {
  initialTuneSession,
  reduceTuneSession,
  TUNE_COPY,
  tuneView,
  type TuneSession,
} from "../src/tuneSession.js";

test("generation healthcheck treats skip and publish as success and failure as fail", () => {
  assert.equal(
    healthcheckKindForGeneration({ status: "skipped", reason: "episode_already_published" }),
    "success",
  );
  assert.equal(healthcheckKindForGeneration({ status: "published" }), "success");
  assert.equal(healthcheckKindForGeneration({ status: "failed" }), "fail");
});

test("feed poll is live, pending, or not_live with the attempt counters the logs use", () => {
  assert.deepEqual(nextFeedPoll({ attempt: 2, sawEpisode: true, pastDeadline: true }), {
    status: "live",
    attempt: 2,
  });
  assert.deepEqual(nextFeedPoll({ attempt: 2, sawEpisode: false, pastDeadline: false }), {
    status: "pending",
    attempt: 2,
  });
  assert.deepEqual(nextFeedPoll({ attempt: 4, sawEpisode: false, pastDeadline: true }), {
    status: "not_live",
    attempts: 4,
  });
});

test("only a loud verification miss pages, and a dark feed retriggers once", () => {
  assert.equal(healthcheckKindForVerification(true, false), "none");
  assert.equal(healthcheckKindForVerification(false, true), "none");
  assert.equal(healthcheckKindForVerification(false, false), "fail");
  assert.equal(nextPagesRecoveryStep("verify_quiet", true), "done");
  assert.equal(nextPagesRecoveryStep("verify_quiet", false), "retrigger_push");
  assert.equal(nextPagesRecoveryStep("verify_loud", true), "done");
  assert.equal(nextPagesRecoveryStep("verify_loud", false), "failed");
});

test("daily.yml recovery steps stay in the legal order", async () => {
  const workflow = await readFile(".github/workflows/daily.yml", "utf8");
  let at = 0;
  for (const name of PAGES_RECOVERY_STEP_NAMES) {
    const found = workflow.indexOf(`name: ${name}`, at);
    assert.ok(found > at, name);
    at = found;
  }
});

test("index.ts logs generation steps in order and pings through the generation outcome", async () => {
  const source = await readFile("src/index.ts", "utf8");
  let at = 0;
  for (const step of GENERATION_STEP_ORDER) {
    const found = source.indexOf(`step: "${step}"`, at);
    assert.ok(found > at, step);
    at = found;
  }
  assert.match(source, /pingHealthcheck\("start"\)/);
  assert.match(source, /healthcheckKindForGeneration\(\{ status: "skipped", reason: "episode_already_published" \}\)/);
  assert.match(source, /healthcheckKindForGeneration\(\{ status: "published" \}\)/);
  assert.match(source, /healthcheckKindForGeneration\(\{ status: "failed" \}\)/);
  assert.doesNotMatch(source, /pingHealthcheck\("success"\)/);
  assert.doesNotMatch(source, /pingHealthcheck\("fail"\)/);
});

test("interest profile mode is default, custom, or disabled", () => {
  const fallback = "  standing lean  ";
  assert.deepEqual(resolveInterestProfileMode(undefined, fallback), {
    mode: "default",
    text: "standing lean",
  });
  assert.deepEqual(resolveInterestProfileMode("  tooling  ", fallback), {
    mode: "custom",
    text: "tooling",
  });
  assert.deepEqual(resolveInterestProfileMode("   ", fallback), { mode: "disabled" });
  assert.equal(interestProfileText({ mode: "disabled" }), "");
  assert.equal(interestProfileText({ mode: "custom", text: "tooling" }), "tooling");
});

test("asset cues fall back to tone only when the files are missing", () => {
  assert.equal(cueStyleAfterAssetLookup("asset", true), "asset");
  assert.equal(cueStyleAfterAssetLookup("asset", false), "tone");
  assert.equal(cueStyleAfterAssetLookup("chime", false), "chime");
  assert.equal(cueStyleAfterAssetLookup("tick", true), "tick");
});

test("script model step accepts, falls through, or exhausts", () => {
  assert.deepEqual(scriptModelStep("a", "b", true), { step: "accept", model: "a" });
  assert.deepEqual(scriptModelStep("a", "b", false), { step: "fallback", model: "a", nextModel: "b" });
  assert.deepEqual(scriptModelStep("b", undefined, false), { step: "exhaust", model: "b" });
});

test("an aired story is new or a follow-up, and show-config reads name their fallback", () => {
  assert.equal(airedStoryDisposition(false), "new");
  assert.equal(airedStoryDisposition(true), "follow_up");
  assert.deepEqual(showConfigReadOutcome("ok"), { status: "loaded" });
  assert.deepEqual(showConfigReadOutcome("enoent"), { status: "fallback", reason: "missing" });
  assert.deepEqual(showConfigReadOutcome("unreadable"), { status: "fallback", reason: "unreadable" });
  assert.deepEqual(showConfigReadOutcome("invalid"), { status: "fallback", reason: "invalid" });
});

test("a TTS part stays whole through the provider character cap", () => {
  assert.equal(ttsPartPlan(100, 100), "whole");
  assert.equal(ttsPartPlan(101, 100), "chunked");
});

function ready(sha = "abc"): TuneSession {
  const loaded = reduceTuneSession(initialTuneSession(), { type: "load" });
  const done = reduceTuneSession(loaded.session, { type: "load_ok", sha });
  return done.session;
}

test("tune session keeps edits typed during a save", () => {
  let session = ready();
  session = reduceTuneSession(session, { type: "edit" }).session;
  const saving = reduceTuneSession(session, { type: "save", missing: [] });
  assert.equal(saving.accepted, true);
  assert.equal(tuneView(saving.session).saveEnabled, false);
  assert.equal(tuneView(saving.session).warnOnLeave, true);
  const typed = reduceTuneSession(saving.session, { type: "edit" });
  const saved = reduceTuneSession(typed.session, { type: "save_ok", sha: "def" });
  assert.equal(saved.session.phase.phase, "ready");
  if (saved.session.phase.phase === "ready") assert.equal(saved.session.phase.dirty, true);
  assert.equal(saved.session.save.text, TUNE_COPY.savedDiverged);
  assert.equal(tuneView(saved.session).warnOnLeave, true);
});

test("tune session clears a clean save and drops the saved notice on the next edit", () => {
  let session = ready();
  session = reduceTuneSession(session, { type: "edit" }).session;
  session = reduceTuneSession(session, { type: "save", missing: [] }).session;
  session = reduceTuneSession(session, { type: "save_ok", sha: "def" }).session;
  assert.equal(session.save.text, TUNE_COPY.saved);
  assert.equal(tuneView(session).warnOnLeave, false);
  session = reduceTuneSession(session, { type: "edit" }).session;
  assert.equal(session.save.text, "");
  assert.equal(tuneView(session).warnOnLeave, true);
});

test("a refused load during save does not stick after the save finishes", () => {
  let session = ready();
  session = reduceTuneSession(session, { type: "edit" }).session;
  session = reduceTuneSession(session, { type: "save", missing: [] }).session;
  session = reduceTuneSession(session, { type: "load" }).session;
  assert.equal(session.connect.text, TUNE_COPY.stillSaving);
  session = reduceTuneSession(session, { type: "save_ok", sha: "def" }).session;
  assert.equal(session.connect.text, TUNE_COPY.loaded);
  assert.equal(session.save.text, TUNE_COPY.saved);
  assert.equal(tuneView(session).warnOnLeave, false);
});

test("tune session refuses load during save and save during load", () => {
  let session = ready();
  session = reduceTuneSession(session, { type: "edit" }).session;
  session = reduceTuneSession(session, { type: "save", missing: [] }).session;
  const load = reduceTuneSession(session, { type: "load" });
  assert.equal(load.accepted, false);
  assert.equal(load.session.phase.phase, "saving");
  assert.equal(load.session.connect.text, TUNE_COPY.stillSaving);

  const loading = reduceTuneSession(ready(), { type: "load" });
  const save = reduceTuneSession(loading.session, { type: "save", missing: [] });
  assert.equal(save.accepted, false);
  assert.equal(save.session.phase.phase, "loading");
});

test("a tune conflict reload keeps the explanation and a failed reload returns to the editor", () => {
  let session = ready("old");
  session = reduceTuneSession(session, { type: "edit" }).session;
  session = reduceTuneSession(session, { type: "save", missing: [] }).session;
  const conflict = reduceTuneSession(session, { type: "save_conflict" });
  assert.equal(conflict.session.save.text, TUNE_COPY.conflictLoading);
  assert.equal(conflict.session.phase.phase, "loading");
  const reloaded = reduceTuneSession(conflict.session, { type: "load_ok", sha: "new" });
  assert.equal(reloaded.session.save.text, TUNE_COPY.conflictLoaded);
  assert.equal(reloaded.session.save.tone, "error");
  if (reloaded.session.phase.phase === "ready") {
    assert.equal(reloaded.session.phase.sha, "new");
    assert.equal(reloaded.session.phase.dirty, false);
  }

  const failed = reduceTuneSession(conflict.session, { type: "load_err", message: "offline" });
  assert.equal(failed.session.phase.phase, "ready");
  assert.equal(failed.session.save.text, "offline");
  assert.equal(tuneView(failed.session).showEditor, true);
});

test("a first tune load failure stays on the connect card", () => {
  const loading = reduceTuneSession(initialTuneSession(), { type: "load" });
  assert.equal(tuneView(loading.session).showEditor, false);
  const failed = reduceTuneSession(loading.session, { type: "load_err", message: "nope" });
  assert.equal(failed.session.phase.phase, "idle");
  assert.equal(tuneView(failed.session).showEditor, false);
  assert.equal(failed.session.connect.text, "nope");
});

test("validation blocks a tune save and forgetting the token leaves the editor up", () => {
  let session = ready();
  const blocked = reduceTuneSession(session, { type: "save", missing: ["Name"] });
  assert.equal(blocked.accepted, false);
  assert.match(blocked.session.save.text, /Still needed: Name/);
  assert.equal(blocked.session.phase.phase, "ready");
  session = reduceTuneSession(session, { type: "forget" }).session;
  assert.equal(session.phase.phase, "ready");
  assert.equal(session.connect.text, TUNE_COPY.forgot);
  assert.equal(tuneView(session).showEditor, true);
});

test("the browser tune session is the transpiled source and it runs", async () => {
  const source = await readFile("src/tuneSession.ts", "utf8");
  const browser = await readFile("docs/tune/session.js", "utf8");
  assert.equal(browser, renderTuneSessionModule(source));
  const html = await readFile("docs/tune/index.html", "utf8");
  assert.match(html, /from "\.\/session\.js"/);
  assert.doesNotMatch(html, /let dirty/);
  assert.doesNotMatch(html, /let sha/);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { initialTuneSession, reduceTuneSession } from "./docs/tune/session.js";
       const next = reduceTuneSession(initialTuneSession(), { type: "load" });
       if (!next.accepted || next.session.phase.phase !== "loading") process.exit(1);`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});
