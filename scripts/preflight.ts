import "dotenv/config";
import { assertPreflight } from "../src/preflight.js";
import { loadShowConfig } from "../src/showConfig.js";

try {
  const show = await loadShowConfig();
  await assertPreflight({ fileVoice: show.tts.voice });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
