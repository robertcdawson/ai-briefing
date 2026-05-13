import assert from "node:assert/strict";
import test from "node:test";
import { execa } from "execa";

test("withHardTimeout clears its timer after a fast operation resolves", async () => {
  const child = await execa(
    "npx",
    [
      "tsx",
      "-e",
      "(async () => { const { withHardTimeout } = await import('./src/util.ts'); await withHardTimeout(Promise.resolve('ok'), 2000, 'fast'); })();",
    ],
    { timeout: 1500 },
  );

  assert.equal(child.exitCode, 0);
});
