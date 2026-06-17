import test from "node:test";
import assert from "node:assert/strict";
import { applyPronunciations, type Pronunciation } from "../src/pronunciations.js";
import { buildPartSpeechRequest, resolveTTSProviderConfig } from "../src/tts.js";

test("applyPronunciations replaces a whole-word term with its spoken form", () => {
  assert.equal(applyPronunciations("Qwen is fast"), "Chwen is fast");
});

test("applyPronunciations matches case-insensitively", () => {
  assert.equal(applyPronunciations("qwen QWEN Qwen"), "Chwen Chwen Chwen");
});

test("applyPronunciations preserves surrounding punctuation", () => {
  assert.equal(applyPronunciations("(Qwen), Qwen. Qwen!"), "(Chwen), Chwen. Chwen!");
});

test("applyPronunciations does not match inside a larger word (no substring false positive)", () => {
  // "Grok" is in the default lexicon; "Grokking" must be left alone.
  assert.equal(applyPronunciations("Grokking the Grok model"), "Grokking the Grock model");

  // Custom lexicon proves the boundary guard generally: "AI" must not hit "rain"/"plain".
  const lex: Pronunciation[] = [{ term: "AI", say: "AY-EYE" }];
  assert.equal(applyPronunciations("rain and plain AI", lex), "rain and plain AY-EYE");
});

test("applyPronunciations handles multiple terms in one string", () => {
  assert.equal(
    applyPronunciations("Qwen, Mistral, and Nvidia"),
    "Chwen, Miss-trahl, and En-vid-ee-uh",
  );
});

test("applyPronunciations prefers the longer (multi-word) term on overlap", () => {
  const lex: Pronunciation[] = [
    { term: "Yann", say: "WRONG" },
    { term: "Yann LeCun", say: "Yann Luh-Kuhn" },
  ];
  assert.equal(applyPronunciations("Yann LeCun spoke", lex), "Yann Luh-Kuhn spoke");
});

test("applyPronunciations is a no-op for an empty lexicon or no match", () => {
  assert.equal(applyPronunciations("Qwen", []), "Qwen");
  assert.equal(applyPronunciations("nothing notable here"), "nothing notable here");
});

test("buildPartSpeechRequest respells the TTS input but does not mutate the source chunks", () => {
  const chunks = ["Qwen and Nvidia shipped models."];
  const config = resolveTTSProviderConfig();
  const request = buildPartSpeechRequest(chunks, config);

  // The spoken input is respelled...
  assert.match(request.input, /Chwen/);
  assert.match(request.input, /En-vid-ee-uh/);
  assert.doesNotMatch(request.input, /Qwen/);

  // ...but the canonical source text is untouched (transcript stays correct).
  assert.equal(chunks[0], "Qwen and Nvidia shipped models.");
});
