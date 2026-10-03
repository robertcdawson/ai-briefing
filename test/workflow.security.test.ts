import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const workflow = await readFile(".github/workflows/daily.yml", "utf8");

test("both verification paths deny npm the deploy key, key file, and SSH handle", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "workflow-secret-test-"));
  try {
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    const key = path.join(dir, "test-key");
    const stub = async (name: string, text: string) => writeFile(path.join(bin, name), `#!/bin/sh\n${text}\n`, { mode: 0o700 });
    await stub("git", "exit 0");
    await stub("mktemp", 'printf "%s\\n" "$TEST_KEY_PATH"');
    await stub("npx", `[ -z "$DAILY_PUSH_DEPLOY_KEY" ] || exit 91
[ -z "$GIT_SSH_COMMAND" ] || exit 92
[ ! -e "$TEST_KEY_PATH" ] || exit 93
printf 'verified\\n' >> "$TEST_LOG"
case "$*" in *--quiet*) exit "\${TEST_INITIAL_STATUS:-1}" ;; esac`);
    const steps = workflow.split("      - name: ");
    const first = steps.find(s => s.startsWith("Verify published feed"))!;
    const redeploy = steps.find(s => s.startsWith("Retrigger Pages deployment"))!;
    const last = steps.find(s => s.startsWith("Verify retriggered feed"))!;
    for (const step of [first, last]) assert.doesNotMatch(step, /DAILY_PUSH_DEPLOY_KEY/);
    assert.doesNotMatch(redeploy, /npx|npm|node /);
    const body = (step: string) => (step.includes("        run: |\n")
      ? step.split("        run: |\n")[1]!.split("\n").map(l => l.replace(/^          /, "")).join("\n")
      : step.split("        run: ")[1]!).replace(/\$\{\{ github.ref_name \}\}/g, "main")
        .replace(/\$\{\{ github.repository \}\}/g, "example/repo");
    for (const initial of ["0", "1"]) {
      const log = path.join(dir, `log-${initial}`);
      const output = path.join(dir, `output-${initial}`);
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_KEY_PATH: key, TEST_LOG: log, TEST_INITIAL_STATUS: initial, GITHUB_OUTPUT: output };
      const run = (step: string, extra = {}) => {
        const result = spawnSync("bash", ["-e", "-c", body(step)], { encoding: "utf8", env: { ...env, ...extra } });
        assert.equal(result.status, 0, result.stderr);
      };
      run(first);
      assert.equal((await readFile(output, "utf8")).trim(), `live=${initial === "0"}`);
      if (initial === "1") {
        run(redeploy, { DAILY_PUSH_DEPLOY_KEY: "fake-test-key" });
        run(last);
      }
      assert.equal((await readFile(log, "utf8")).trim().split("\n").length, initial === "0" ? 1 : 2);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("scheduled checkout resolves the current branch and missing interest vars preserve defaults", () => {
  assert.match(workflow, /ref: \$\{\{ github.ref_name \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /vars.INTEREST_PROFILE \|\| '__DEFAULT_INTEREST_PROFILE__'/);
  assert.match(workflow, /unset INTEREST_PROFILE/);
});

test("invalid timezone produces a structured pipeline error before any paid stages", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
    encoding: "utf8", env: { ...process.env, EPISODE_TIME_ZONE: "not/a-timezone", HEALTHCHECK_URL: "" },
  });
  assert.equal(result.status, 1);
  const lines = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.ok(lines.some(line => line.phase === "pipeline" && line.status === "error" && /time zone/i.test(line.error)));
  assert.ok(!lines.some(line => line.phase === "tts" || line.phase === "curate"));
});
