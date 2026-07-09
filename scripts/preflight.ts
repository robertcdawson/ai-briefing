import "dotenv/config";
import { assertPreflight } from "../src/preflight.js";

try {
  await assertPreflight();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
