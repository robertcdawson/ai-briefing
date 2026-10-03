import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = readdirSync("test").filter(f => f.endsWith(".test.ts") && f !== "publish.apple-rss.test.ts").sort().map(f => `test/${f}`);
function run(args) {
  const result = spawnSync(process.execPath, ["--import", "tsx", ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(["test/publish.apple-rss.test.ts"]);
run(["--test", ...process.argv.slice(2), ...files]);
