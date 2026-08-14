import assert from "node:assert/strict";
import test from "node:test";
import {
  EAR_EDIT_RESPONSE_SCHEMA,
  buildEarEditCompletionParams,
  buildEarEditSystemPrompt,
  buildEarEditUserPrompt,
  earEdit,
  mergeEarEdit,
  resolveEarEditEnabled,
  resolveEarEditModels,
} from "../src/earEdit.js";
import type { EarEditResponse } from "../src/earEdit.js";
import type { ScriptCompletionClient, ScriptCompletionParams } from "../src/script.js";
import type { Episode, StoryCluster } from "../src/types.js";

const CLUSTERS: StoryCluster[] = [
  {
    canonicalKey: "test-story",
    category: "product-tools",
    headline: "A model ships a useful feature",
    whyItMatters: "Builders get a simpler path to production.",
    caveat: "Benchmarks are still early.",
    sources: [{ publisher: "Example News", url: "https://example.com/model-feature" }],
  },
];

function makeEpisode(): Episode {
  return {
    date: "2026-08-14",
    title: "AI Briefing — August 14, 2026",
    intro: ["Here is the setup.", "Here is why it matters."],
    segments: [
      {
        title: "Top Story: A model ships a useful feature",
        chunks: ["A concise segment.", "Another sentence here."],
        sourceUrls: ["https://example.com/model-feature"],
        stance: "I called this correctly.",
        delivery: "measured",
      },
    ],
    outro: ["A quiet day ends loudly.", "Back tomorrow."],
    audioPath: "",
    byteLength: 0,
    durationSeconds: 0,
  };
}

function editedResponseFrom(episode: Episode, overrides: Partial<EarEditResponse> = {}): EarEditResponse {
  return {
    intro: episode.intro,
    segments: episode.segments.map((s) => ({
      title: s.title,
      chunks: s.chunks,
      sourceUrls: s.sourceUrls,
      stance: s.stance ?? null,
      delivery: s.delivery ?? null,
    })),
    outro: episode.outro,
    edits: [],
    ...overrides,
  };
}

function fakeClient(
  handler: (params: ScriptCompletionParams) => { content: string } | { throwError: Error },
): ScriptCompletionClient {
  return {
    async create(params) {
      const outcome = handler(params);
      if ("throwError" in outcome) throw outcome.throwError;
      return {
        id: "fake",
        object: "chat.completion",
        model: params.model,
        choices: [{ finish_reason: "stop", message: { content: outcome.content } }],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// resolveEarEditEnabled
// ---------------------------------------------------------------------------

test("resolveEarEditEnabled defaults to true when unset or empty", () => {
  assert.equal(resolveEarEditEnabled(undefined), true);
  assert.equal(resolveEarEditEnabled(""), true);
});

test("resolveEarEditEnabled is false for common falsey values (case-insensitive), true otherwise", () => {
  for (const value of ["0", "false", "off", "no", "FALSE", "Off"]) {
    assert.equal(resolveEarEditEnabled(value), false, `expected "${value}" to disable`);
  }
  for (const value of ["1", "true", "on", "yes"]) {
    assert.equal(resolveEarEditEnabled(value), true, `expected "${value}" to enable`);
  }
});

// ---------------------------------------------------------------------------
// resolveEarEditModels
// ---------------------------------------------------------------------------

test("resolveEarEditModels prefers OPENROUTER_EAR_EDIT_MODEL over OPENROUTER_SCRIPT_MODEL", () => {
  assert.deepEqual(
    resolveEarEditModels({ OPENROUTER_EAR_EDIT_MODEL: "ear/model", OPENROUTER_SCRIPT_MODEL: "script/model" }),
    ["ear/model"],
  );
});

test("resolveEarEditModels falls back to OPENROUTER_SCRIPT_MODEL when EAR_EDIT_MODEL is unset", () => {
  assert.deepEqual(resolveEarEditModels({ OPENROUTER_SCRIPT_MODEL: "script/model" }), ["script/model"]);
});

test("resolveEarEditModels falls back to the script defaults when both are unset", () => {
  const models = resolveEarEditModels({});
  assert.ok(models.length > 0);
  assert.equal(models[0], "anthropic/claude-sonnet-4.6");
});

// ---------------------------------------------------------------------------
// Prompt / params construction
// ---------------------------------------------------------------------------

test("buildEarEditCompletionParams pins temperature, strict schema, and provider routing", () => {
  const params = buildEarEditCompletionParams("test/model", makeEpisode(), CLUSTERS);

  assert.equal(params.model, "test/model");
  assert.equal(params.temperature, 0.3);
  assert.equal(params.stream, false);
  assert.deepEqual(params.provider, { require_parameters: true });
  assert.equal(params.response_format?.type, "json_schema");
  if (params.response_format?.type === "json_schema") {
    assert.equal(params.response_format.json_schema.strict, true);
    assert.equal(params.response_format.json_schema.schema, EAR_EDIT_RESPONSE_SCHEMA);
  }
});

test("buildEarEditSystemPrompt instructs a minimal, constrained edit pass", () => {
  const prompt = buildEarEditSystemPrompt();
  assert.match(prompt, /self-endorsements/i);
  assert.match(prompt, /NEVER change segment count/);
  assert.match(prompt, /never add facts/i);
  assert.match(prompt, /within about 10%/);
});

test("buildEarEditUserPrompt includes the script JSON and the editor's notes", () => {
  const prompt = buildEarEditUserPrompt(makeEpisode(), CLUSTERS);
  assert.match(prompt, /A concise segment\./);
  assert.match(prompt, /Builders get a simpler path to production\./);
  assert.match(prompt, /never echo their wording/);
});

// ---------------------------------------------------------------------------
// mergeEarEdit
// ---------------------------------------------------------------------------

test("mergeEarEdit takes chunks from the edit but forces sourceUrls/stance/delivery from the original", () => {
  const episode = makeEpisode();
  const response = editedResponseFrom(episode, {
    intro: ["A tighter opening line."],
    segments: [
      {
        title: episode.segments[0]!.title,
        chunks: ["A tighter segment sentence."],
        sourceUrls: ["https://example.com/hijacked"],
        stance: "A different take entirely",
        delivery: "excited",
      },
    ],
    outro: ["A tighter close."],
    edits: [{ location: "intro", reason: "cut a warm-up sentence" }],
  });

  const merged = mergeEarEdit(episode, response);

  assert.deepEqual(merged.intro, ["A tighter opening line."]);
  assert.deepEqual(merged.outro, ["A tighter close."]);
  assert.deepEqual(merged.segments[0]?.chunks, ["A tighter segment sentence."]);
  assert.equal(merged.segments[0]?.title, episode.segments[0]!.title);
  assert.deepEqual(merged.segments[0]?.sourceUrls, episode.segments[0]!.sourceUrls);
  assert.equal(merged.segments[0]?.stance, episode.segments[0]!.stance);
  assert.equal(merged.segments[0]?.delivery, episode.segments[0]!.delivery);
});

test("mergeEarEdit throws when the edit changes a segment title", () => {
  const episode = makeEpisode();
  const base = editedResponseFrom(episode);
  const response = editedResponseFrom(episode, {
    segments: [{ ...base.segments[0]!, title: "Top Story: A completely different headline" }],
  });
  assert.throws(() => mergeEarEdit(episode, response), /changed the title/);
});

test("mergeEarEdit throws when the segment count changes", () => {
  const episode = makeEpisode();
  const response = editedResponseFrom(episode, { segments: [] });
  assert.throws(() => mergeEarEdit(episode, response), /expected 1/);
});

test("mergeEarEdit throws when intro or outro chunks are empty", () => {
  const episode = makeEpisode();
  assert.throws(
    () => mergeEarEdit(episode, editedResponseFrom(episode, { intro: [] })),
    /intro chunks must be a non-empty array/,
  );
  assert.throws(
    () => mergeEarEdit(episode, editedResponseFrom(episode, { outro: [] })),
    /outro chunks must be a non-empty array/,
  );
});

// ---------------------------------------------------------------------------
// earEdit: happy path
// ---------------------------------------------------------------------------

test("earEdit returns the edited episode and surfaces the edit log on success", async () => {
  const episode = makeEpisode();
  // Trimmed by 2 of 22 total words (~9% drift) — comfortably inside the ±30%
  // guard. The fixture episode is short, so the edit must stay close in
  // length or it trips the same guard this suite exercises deliberately
  // elsewhere.
  const response = editedResponseFrom(episode, {
    intro: ["Here is the setup, tighter now."],
    edits: [{ location: "intro", reason: "cut a warm-up sentence" }],
  });
  const client = fakeClient(() => ({ content: JSON.stringify(response) }));

  const result = await earEdit(episode, CLUSTERS, [], { completionClient: client, retryBaseMs: 0 });

  assert.equal(result.edited, true);
  assert.deepEqual(result.edits, [{ location: "intro", reason: "cut a warm-up sentence" }]);
  assert.deepEqual(result.episode.intro, ["Here is the setup, tighter now."]);
  assert.equal(result.episode.segments[0]?.title, episode.segments[0]!.title);
  assert.equal(result.episode.segments[0]?.stance, episode.segments[0]!.stance);
});

// ---------------------------------------------------------------------------
// earEdit: fallback matrix — every failure mode returns the ORIGINAL episode
// unedited rather than propagating an error.
// ---------------------------------------------------------------------------

test("earEdit falls back to the original episode when the completion client throws", async () => {
  const episode = makeEpisode();
  const client = fakeClient(() => ({ throwError: new Error("network error") }));

  const result = await earEdit(episode, CLUSTERS, [], { completionClient: client, retryBaseMs: 0 });

  assert.equal(result.edited, false);
  assert.deepEqual(result.edits, []);
  assert.equal(result.episode, episode);
});

test("earEdit falls back when the response is not valid JSON", async () => {
  const episode = makeEpisode();
  const client = fakeClient(() => ({ content: "not json" }));

  const result = await earEdit(episode, CLUSTERS, [], { completionClient: client, retryBaseMs: 0 });

  assert.equal(result.edited, false);
  assert.equal(result.episode, episode);
});

test("earEdit falls back when the edit returns the wrong segment count", async () => {
  const episode = makeEpisode();
  const response = editedResponseFrom(episode, { segments: [] });
  const client = fakeClient(() => ({ content: JSON.stringify(response) }));

  const result = await earEdit(episode, CLUSTERS, [], { completionClient: client, retryBaseMs: 0 });

  assert.equal(result.edited, false);
  assert.equal(result.episode, episode);
});

test("earEdit falls back when the edited outro trips a hard-fail validator", async () => {
  const episode = makeEpisode();
  const response = editedResponseFrom(episode, {
    outro: ["Pull back and look at today's stories together.", "Good night."],
  });
  const client = fakeClient(() => ({ content: JSON.stringify(response) }));

  const result = await earEdit(episode, CLUSTERS, [], { completionClient: client, retryBaseMs: 0 });

  assert.equal(result.edited, false);
  assert.equal(result.episode, episode);
});

test("earEdit falls back when the edit reuses phrasing worn out in recent episodes", async () => {
  const episode = makeEpisode();
  const response = editedResponseFrom(episode, {
    intro: ["This number is worth sitting with for a moment."],
  });
  const client = fakeClient(() => ({ content: JSON.stringify(response) }));

  const result = await earEdit(episode, CLUSTERS, [{ gram: "worth sitting with", episodeCount: 5 }], {
    completionClient: client,
    retryBaseMs: 0,
  });

  assert.equal(result.edited, false);
  assert.equal(result.episode, episode);
});

test("earEdit falls back when the edit changes the word count beyond the guard", async () => {
  const episode = makeEpisode();
  const paddedChunks = Array.from(
    { length: 40 },
    (_, i) => `This is padding sentence number ${i} that adds a great many extra words to inflate the total count well past the guard.`,
  );
  const response = editedResponseFrom(episode, {
    segments: [
      {
        title: episode.segments[0]!.title,
        chunks: paddedChunks,
        sourceUrls: episode.segments[0]!.sourceUrls,
        stance: null,
        delivery: null,
      },
    ],
  });
  const client = fakeClient(() => ({ content: JSON.stringify(response) }));

  const result = await earEdit(episode, CLUSTERS, [], { completionClient: client, retryBaseMs: 0 });

  assert.equal(result.edited, false);
  assert.equal(result.episode, episode);
});

// ---------------------------------------------------------------------------
// Model fallback chain
// ---------------------------------------------------------------------------

test("earEdit falls back to the next configured model after the first model errors", async (t) => {
  const originalEarModel = process.env.OPENROUTER_EAR_EDIT_MODEL;
  process.env.OPENROUTER_EAR_EDIT_MODEL = "primary/model,fallback/model";
  t.after(() => {
    if (originalEarModel === undefined) delete process.env.OPENROUTER_EAR_EDIT_MODEL;
    else process.env.OPENROUTER_EAR_EDIT_MODEL = originalEarModel;
  });

  const episode = makeEpisode();
  const goodResponse = editedResponseFrom(episode, { intro: ["Fallback model's tighter opening."] });
  const requests: string[] = [];
  const client = fakeClient((params) => {
    requests.push(params.model);
    if (params.model === "primary/model") return { throwError: new Error("primary model unavailable") };
    return { content: JSON.stringify(goodResponse) };
  });

  const result = await earEdit(episode, CLUSTERS, [], { completionClient: client, retryBaseMs: 0 });

  assert.equal(result.edited, true);
  assert.deepEqual(result.episode.intro, ["Fallback model's tighter opening."]);
  assert.ok(requests.includes("primary/model"));
  assert.ok(requests.includes("fallback/model"));
});
