import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { cacheKey, stageCacheDir, withStageCache } from "../src/stageCache.js";

async function tmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "stage-cache-test-"));
}

test("cacheKey is deterministic and input-sensitive", () => {
  assert.equal(cacheKey("curate", { a: 1 }), cacheKey("curate", { a: 1 }));
  assert.notEqual(cacheKey("curate", { a: 1 }), cacheKey("curate", { a: 2 }));
  assert.notEqual(cacheKey("curate", { a: 1 }), cacheKey("script", { a: 1 }));
});

test("stageCacheDir returns undefined when unset/blank, trimmed value when set", () => {
  assert.equal(stageCacheDir({}), undefined);
  assert.equal(stageCacheDir({ STAGE_CACHE_DIR: "  " }), undefined);
  assert.equal(stageCacheDir({ STAGE_CACHE_DIR: "  /tmp/x  " }), "/tmp/x");
});

test("withStageCache computes every time when caching is disabled (no dir)", async () => {
  let calls = 0;
  const compute = async () => ++calls;
  await withStageCache("curate", { k: 1 }, compute, { dir: undefined });
  await withStageCache("curate", { k: 1 }, compute, { dir: undefined });
  assert.equal(calls, 2, "no caching -> compute runs each time");
});

test("withStageCache stores then reuses on identical input, recomputes on different input", async () => {
  const dir = await tmp();
  try {
    let calls = 0;
    const compute = async () => ({ value: ++calls });

    const first = await withStageCache("curate", { k: 1 }, compute, { dir });
    const second = await withStageCache("curate", { k: 1 }, compute, { dir });
    assert.deepEqual(first, { value: 1 });
    assert.deepEqual(second, { value: 1 }, "identical input -> cached result, compute not re-run");
    assert.equal(calls, 1, "compute ran exactly once for the repeated input");

    const third = await withStageCache("curate", { k: 2 }, compute, { dir });
    assert.deepEqual(third, { value: 2 }, "different input -> recomputed");
    assert.equal(calls, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withStageCache falls back to compute on a corrupt cache file (no throw)", async () => {
  const dir = await tmp();
  try {
    // Pre-write a corrupt cache file for the exact key this call will look up.
    const key = cacheKey("curate", { k: 9 });
    await writeFile(path.join(dir, `curate-${key}.json`), "{ not json", "utf8");

    let calls = 0;
    const result = await withStageCache("curate", { k: 9 }, async () => ({ ok: ++calls }), { dir });
    assert.deepEqual(result, { ok: 1 }, "corrupt cache -> recomputed");
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
