import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Browser bundle of `src/tuneSession.ts`. The tune page imports this file. */
export function renderTuneSessionModule(source: string): string {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
    fileName: "tuneSession.ts",
  });
  return `// Generated from src/tuneSession.ts. Do not edit by hand.\n${result.outputText}`;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked.endsWith(`${path.sep}emit-tune-session.ts`)) {
  const source = await readFile(path.join(root, "src/tuneSession.ts"), "utf8");
  await writeFile(path.join(root, "docs/tune/session.js"), renderTuneSessionModule(source));
}
