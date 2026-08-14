import assert from "node:assert/strict";
import test from "node:test";
import { ALLOWED_INLINE_AUDIO_TAGS } from "../src/audioTags.js";
import {
  BANNED_SCRIPT_PHRASES,
  SCRIPT_RESPONSE_SCHEMA,
  buildDirectOpenAICompletionParams,
  buildScriptCompletionParams,
  buildSystemPrompt,
  buildUserPrompt,
  resolveScriptModel,
  resolveScriptModels,
  resolveScriptTimeoutMs,
  reconcileScriptSourceUrls,
  validateScriptResponse,
  writeScript,
} from "../src/script.js";
import type { ScriptCompletionClient, ScriptCompletionParams, ScriptResponse } from "../src/script.js";
import type { StoryCluster } from "../src/types.js";
import { HOST_IDENTITY, VOICE_EXEMPLARS } from "../src/voice.js";

test("resolveScriptModels defaults to Sonnet for prose quality with cheaper fallbacks", () => {
  const expectedDefaults = [
    "anthropic/claude-sonnet-4.6",
    "google/gemini-3.1-pro-preview",
    "openai/gpt-4o-mini",
  ];
  assert.deepEqual(resolveScriptModels(undefined), expectedDefaults);
  assert.deepEqual(resolveScriptModels(""), expectedDefaults);
  assert.deepEqual(resolveScriptModels("   "), expectedDefaults);
});

test("resolveScriptModels accepts single and comma-separated configured models", () => {
  assert.deepEqual(
    resolveScriptModels(" anthropic/claude-sonnet-4.6 "),
    ["anthropic/claude-sonnet-4.6"],
  );
  assert.deepEqual(
    resolveScriptModels(" primary/model, fallback/model ,  "),
    ["primary/model", "fallback/model"],
  );
});

test("resolveScriptModel preserves single-model compatibility", () => {
  assert.equal(resolveScriptModel(undefined), "anthropic/claude-sonnet-4.6");
  assert.equal(resolveScriptModel(""), "anthropic/claude-sonnet-4.6");
  assert.equal(resolveScriptModel("   "), "anthropic/claude-sonnet-4.6");
  assert.equal(
    resolveScriptModel(" anthropic/claude-sonnet-4.6 "),
    "anthropic/claude-sonnet-4.6",
  );
  assert.equal(resolveScriptModel(" primary/model, fallback/model "), "primary/model");
});

test("buildDirectOpenAICompletionParams strips OpenRouter provider routing", () => {
  const params = buildScriptCompletionParams(
    "openai/gpt-4o-mini",
    "2026-05-16",
    [
      {
        canonicalKey: "test-story",
        category: "product-tools",
        headline: "A model ships a useful feature",
        whyItMatters: "Builders get a simpler path to production.",
        caveat: "Benchmarks are still early.",
        sources: [{ publisher: "Example News", url: "https://example.com/model-feature" }],
      },
    ],
  );

  const directParams = buildDirectOpenAICompletionParams(params);

  assert.equal(directParams.model, "gpt-4o-mini");
  assert.equal("provider" in directParams, false);
  assert.deepEqual(directParams.response_format, params.response_format);
});

test("resolveScriptTimeoutMs uses a realistic default and accepts valid overrides", () => {
  assert.equal(resolveScriptTimeoutMs(undefined), 360_000);
  assert.equal(resolveScriptTimeoutMs(""), 360_000);
  assert.equal(resolveScriptTimeoutMs(" 240000 "), 240_000);
  assert.equal(resolveScriptTimeoutMs("59999"), 360_000);
  assert.equal(resolveScriptTimeoutMs("600001"), 600_001);
  assert.equal(resolveScriptTimeoutMs("900000"), 900_000);
  assert.equal(resolveScriptTimeoutMs("900001"), 360_000);
  assert.equal(resolveScriptTimeoutMs("not-a-number"), 360_000);
});

test("buildSystemPrompt describes a persistent host bounded by factual constraints", () => {
  const prompt = buildSystemPrompt();

  assert.match(prompt, /THE HOST/);
  assert.ok(prompt.includes(HOST_IDENTITY.refusals), "the host's refusals must appear verbatim");
  assert.match(prompt, /REGISTER EXEMPLARS/);
  assert.match(prompt, /match their register/i);
  assert.ok(VOICE_EXEMPLARS.length > 0, "at least one voice exemplar must be configured");
  assert.ok(
    prompt.includes(VOICE_EXEMPLARS[0] as string),
    "the first exemplar must appear in the prompt",
  );
  assert.match(prompt, /EMPHASIS BUDGET/);
  assert.match(prompt, /ONE deliberate rhetorical peak/i);
  assert.match(prompt, /one analogy per episode/i);
  assert.match(prompt, /two sentences in a row share a shape/);
  assert.match(prompt, /never invent facts/i);
  assert.match(prompt, /sourceUrls MUST be exactly the urls provided/);
  assert.match(prompt, /single host speaking solo/);
  assert.match(prompt, /solo show/);
  assert.match(prompt, /Do not include speaker labels/);
});

test("buildUserPrompt preserves source publisher, URL, and importance context", () => {
  const clusters: StoryCluster[] = [
    {
      canonicalKey: "test-story",
      category: "product-tools",
      headline: "A model ships a useful feature",
      whyItMatters: "Builders get a simpler path to production.",
      caveat: "Benchmarks are still early.",
      importance: 72,
      sources: [
        { publisher: "Example News", url: "https://example.com/model-feature" },
      ],
    },
  ];

  const prompt = buildUserPrompt("2026-05-11", clusters);

  assert.match(prompt, /Today is 2026-05-11/);
  assert.match(prompt, /STORY 1: A model ships a useful feature/);
  assert.match(prompt, /Category: Product & Tool Watch \(product-tools\)/);
  assert.match(prompt, /Importance: 72\/100/);
  assert.match(prompt, /Example News: https:\/\/example\.com\/model-feature/);
});

test("buildSystemPrompt enforces hook, labels, concise transitions, and explainers", () => {
  const prompt = buildSystemPrompt();

  assert.match(prompt, /Begin with an engaging hook/);
  assert.match(prompt, /exactly one segment per provided story cluster/);
  assert.match(prompt, /Let the news set the length/);
  assert.match(prompt, /Scale depth to each story's importance/);
  assert.match(prompt, /under about ten minutes/);
  assert.match(prompt, /potential impact both good and bad/);
  assert.match(prompt, /first segment title MUST begin "Top Story:/);
  assert.match(prompt, /Product & Tool Watch: \{headline\}/);
  assert.match(prompt, /smooth, short, specific transition/);
  assert.match(prompt, /under about 12 words/);
  assert.match(prompt, /define specialized terms in 8-14 plain words/);
  assert.match(prompt, /never announcer-y or fake-enthusiastic/);
});

test("buildSystemPrompt bans worn-out podcast filler and demands fresh sign-offs", () => {
  const prompt = buildSystemPrompt();

  assert.match(prompt, /BANNED PHRASES/);
  for (const phrase of BANNED_SCRIPT_PHRASES) {
    assert.ok(prompt.includes(`"${phrase}"`), `prompt must ban "${phrase}"`);
  }
  assert.match(prompt, /sign-off must be one short line in the host's voice/);
  assert.match(prompt, /Never build it as "Keep your X and your Y"/);
  assert.match(prompt, /Never a stock farewell/);
});

test("buildSystemPrompt discourages split contrast reversals", () => {
  const prompt = buildSystemPrompt();

  assert.match(prompt, /Avoid split contrast reversals/);
  assert.match(prompt, /That's not X\. It's Y\./);
  assert.match(prompt, /This isn't X\. It's Y\./);
  assert.match(prompt, /one precise sentence or choose a different rhetorical turn/);
});

test("buildSystemPrompt demands concrete specifics", () => {
  const prompt = buildSystemPrompt();

  assert.match(prompt, /at least one specific number, named person or organization, or short direct quote/);
  assert.match(prompt, /Specifics beat adjectives/);
});

test("buildSystemPrompt gates inline delivery tags on the TTS model capability", () => {
  const plainPrompt = buildSystemPrompt();
  assert.equal(plainPrompt.includes("Inline delivery tags"), false);
  assert.match(plainPrompt, /audio cues, or bracketed pauses/);

  const taggedPrompt = buildSystemPrompt({ allowAudioTags: true });
  assert.match(taggedPrompt, /Inline delivery tags:/);
  for (const tag of ALLOWED_INLINE_AUDIO_TAGS) {
    assert.ok(taggedPrompt.includes(tag), `tagged prompt must allow ${tag}`);
  }
  assert.match(taggedPrompt, /at most one tag per story segment/i);
  assert.match(taggedPrompt, /ONLY bracketed text allowed is the approved inline delivery tags/);
});

test("SCRIPT_RESPONSE_SCHEMA requires string narration chunks", () => {
  const schema = SCRIPT_RESPONSE_SCHEMA;
  assert.equal(schema.properties.intro.type, "array");
  assert.equal(schema.properties.intro.items.type, "string");
  assert.equal(schema.properties.outro.type, "array");
  assert.equal(schema.properties.segments.items.properties.chunks.type, "array");
  assert.equal(schema.properties.segments.items.properties.chunks.items.type, "string");
  assertNoArrayMinItemsAboveOne(schema);
  assert.equal("minLength" in schema.properties.segments.items.properties.title, false);
  assert.equal("pattern" in schema.properties.segments.items.properties.title, false);
  assert.equal(
    "minLength" in schema.properties.segments.items.properties.chunks.items,
    false,
  );
  assert.equal(
    "pattern" in schema.properties.segments.items.properties.chunks.items,
    false,
  );
});

test("buildUserPrompt tells the model not to pad fewer-than-three clusters", () => {
  const clusters: StoryCluster[] = [
    {
      canonicalKey: "research-story",
      category: "research",
      headline: "A benchmark exposes model planning gaps",
      whyItMatters: "Researchers get a clearer evaluation target.",
      caveat: "The benchmark may not match production tasks.",
      sources: [{ publisher: "Example Lab", url: "https://example.com/benchmark" }],
    },
    {
      canonicalKey: "policy-story",
      category: "policy-regulation",
      headline: "A regulator clarifies model audit rules",
      whyItMatters: "Builders get a better compliance map.",
      caveat: "The rules may still change after consultation.",
      sources: [{ publisher: "Example Policy", url: "https://example.com/rules" }],
    },
  ];

  const prompt = buildUserPrompt("2026-05-11", clusters);

  assert.match(prompt, /following 2 story clusters/);
  assert.match(prompt, /Return exactly 2 segment objects; never invent or pad/);
});

test("validateScriptResponse preserves segment count and source URLs", () => {
  const clusters: StoryCluster[] = [
    {
      canonicalKey: "test-story",
      category: "product-tools",
      headline: "A model ships a useful feature",
      whyItMatters: "Builders get a simpler path to production.",
      caveat: "Benchmarks are still early.",
      sources: [
        { publisher: "Example News", url: "https://example.com/model-feature" },
        { publisher: "Example Blog", url: "https://example.com/model-feature-details" },
      ],
    },
  ];

  validateScriptResponse(
    {
      intro: ["Here is the setup.", "And here is why it matters."],
      segments: [
        {
          title: "Top Story: A model ships a useful feature",
          chunks: ["A concise segment.", "The practical takeaway is simple."],
          sourceUrls: [
            " https://example.com/model-feature-details ",
            "https://example.com/model-feature",
          ],
        },
      ],
      outro: ["That is the pattern.", "And that is the useful lens."],
    },
    clusters,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: ["Here is the setup.", "Here is the so what."],
          segments: [],
          outro: ["That is the pattern.", "That is the lens."],
        },
        clusters,
      ),
    /expected 1/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: ["Here is the setup.", "Here is the so what."],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              chunks: ["A concise segment.", "The practical takeaway is simple."],
              sourceUrls: ["https://example.com/changed"],
            },
          ],
          outro: ["That is the pattern.", "That is the lens."],
        },
        clusters,
      ),
    /sourceUrls do not match.*missing=.*model-feature.*extra=.*changed/,
  );

  const omittedSourceResponse: ScriptResponse = {
    intro: ["Here is the setup.", "And here is why it matters."],
    segments: [
      {
        title: "Top Story: A model ships a useful feature",
        chunks: ["A concise segment.", "The practical takeaway is simple."],
        sourceUrls: ["https://example.com/model-feature"],
      },
    ],
    outro: ["That is the pattern.", "And that is the useful lens."],
  };

  assert.equal(reconcileScriptSourceUrls(omittedSourceResponse, clusters), 1);
  assert.deepEqual(omittedSourceResponse.segments[0]?.sourceUrls, [
    "https://example.com/model-feature",
    "https://example.com/model-feature-details",
  ]);
  validateScriptResponse(omittedSourceResponse, clusters);

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: ["Here is the setup.", "Here is the so what."],
          outro: ["That is the pattern.", "That is the lens."],
        } as unknown as Parameters<typeof validateScriptResponse>[0],
        clusters,
      ),
    /segments must be an array/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: ["Here is the setup.", "Here is the so what."],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              chunks: ["A concise segment.", "The practical takeaway is simple."],
            },
          ],
          outro: ["That is the pattern.", "That is the lens."],
        } as unknown as Parameters<typeof validateScriptResponse>[0],
        clusters,
      ),
    /sourceUrls must be an array/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: ["Here is the setup.", "Here is the so what."],
          segments: [
            {
              title: " ",
              chunks: ["A concise segment.", "The practical takeaway is simple."],
              sourceUrls: ["https://example.com/model-feature"],
            },
          ],
          outro: ["That is the pattern.", "That is the lens."],
        },
        clusters,
      ),
    /title must be a non-empty string/,
  );
});

test("validateScriptResponse rejects split contrast phrasing variants across read-aloud chunks", () => {
  const clusters: StoryCluster[] = [
    {
      canonicalKey: "test-story",
      category: "product-tools",
      headline: "A model ships a useful feature",
      whyItMatters: "Builders get a simpler path to production.",
      caveat: "Benchmarks are still early.",
      sources: [{ publisher: "Example News", url: "https://example.com/model-feature" }],
    },
  ];

  const validSegment = {
    title: "Top Story: A model ships a useful feature",
    chunks: ["A concise segment.", "The practical takeaway is simple."],
    sourceUrls: ["https://example.com/model-feature"],
  };

  const cases: ScriptResponse[] = [
    {
      intro: ["Here is the setup.", "Here is why it matters."],
      segments: [
        {
          ...validSegment,
          chunks: ["That's not just a benchmark.", "It's a procurement signal."],
        },
      ],
      outro: ["The pattern is practical.", "Keep the signal clean."],
    },
    {
      intro: ["This isn't a routine model release.", "That is a pricing signal."],
      segments: [validSegment],
      outro: ["The pattern is practical.", "Keep the signal clean."],
    },
    {
      intro: ["Here is the setup.", "Here is why it matters."],
      segments: [validSegment],
      outro: ["It is not only a research story.", "This is an infrastructure bet."],
    },
  ];

  for (const response of cases) {
    assert.throws(
      () => validateScriptResponse(response, clusters),
      /discouraged split contrast phrasing/,
    );
  }
});

test("validateScriptResponse allows tentative sourcing calibration", () => {
  const clusters: StoryCluster[] = [
    {
      canonicalKey: "test-story",
      category: "product-tools",
      headline: "A model ships a useful feature",
      whyItMatters: "Builders get a simpler path to production.",
      caveat: "Benchmarks are still early.",
      sources: [{ publisher: "Example News", url: "https://example.com/model-feature" }],
    },
  ];

  const cases: string[][] = [
    ["This isn't confirmed yet.", "It is still worth watching."],
    ["This isn't verified yet.", "It is an unconfirmed report worth watching."],
    ["That isn't official yet.", "This is a rumor builders should treat carefully."],
  ];

  for (const chunks of cases) {
    validateScriptResponse(
      {
        intro: ["Here is the setup.", "Here is why it matters."],
        segments: [
          {
            title: "Top Story: A model ships a useful feature",
            chunks,
            sourceUrls: ["https://example.com/model-feature"],
          },
        ],
        outro: ["The pattern is practical.", "Keep the signal clean."],
      },
      clusters,
    );
  }
});

test("validateScriptResponse rejects malformed narration chunks", () => {
  const clusters: StoryCluster[] = [
    {
      canonicalKey: "test-story",
      category: "product-tools",
      headline: "A model ships a useful feature",
      whyItMatters: "Builders get a simpler path to production.",
      caveat: "Benchmarks are still early.",
      sources: [{ publisher: "Example News", url: "https://example.com/model-feature" }],
    },
  ];

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: [],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              chunks: ["A concise segment.", "The practical takeaway is simple."],
              sourceUrls: ["https://example.com/model-feature"],
            },
          ],
          outro: ["That is the pattern.", "That is the lens."],
        },
        clusters,
      ),
    /intro chunks must include at least 1 chunk/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: ["Here is the setup.", "Here is the so what."],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              chunks: [{ speaker: "anchor", text: "A concise segment." }],
              sourceUrls: ["https://example.com/model-feature"],
            },
          ],
          outro: ["That is the pattern.", "That is the lens."],
        } as unknown as Parameters<typeof validateScriptResponse>[0],
        clusters,
      ),
    /chunk 1 must be a non-empty string/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: ["Here is the setup.", "Here is the so what."],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              chunks: [],
              sourceUrls: ["https://example.com/model-feature"],
            },
          ],
          outro: ["That is the pattern.", "That is the lens."],
        },
        clusters,
      ),
    /segment 1 chunks must include at least 1 chunk/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: ["Here is the setup.", "Here is the so what."],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              chunks: ["A concise segment.", "The practical takeaway is simple."],
              sourceUrls: ["https://example.com/model-feature"],
            },
          ],
          outro: [],
        },
        clusters,
      ),
    /outro chunks must include at least 1 chunk/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: ["Here is the setup.", "Here is the so what."],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              chunks: ["A concise segment.", " "],
              sourceUrls: ["https://example.com/model-feature"],
            },
          ],
          outro: ["That is the pattern.", "That is the lens."],
        },
        clusters,
      ),
    /chunk 2 must be a non-empty string/,
  );
});

test("writeScript falls back to the next configured model after empty choices", async (t) => {
  const originalModel = process.env.OPENROUTER_SCRIPT_MODEL;
  const originalTimeout = process.env.OPENROUTER_SCRIPT_TIMEOUT_MS;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_SCRIPT_MODEL = "primary/model, fallback/model";
  process.env.OPENROUTER_SCRIPT_TIMEOUT_MS = "60000";
  delete process.env.OPENROUTER_API_KEY;
  t.after(() => {
    restoreEnv("OPENROUTER_SCRIPT_MODEL", originalModel);
    restoreEnv("OPENROUTER_SCRIPT_TIMEOUT_MS", originalTimeout);
    restoreEnv("OPENROUTER_API_KEY", originalApiKey);
  });

  const clusters: StoryCluster[] = [
    {
      canonicalKey: "test-story",
      category: "product-tools",
      headline: "A model ships a useful feature",
      whyItMatters: "Builders get a simpler path to production.",
      caveat: "Benchmarks are still early.",
      sources: [{ publisher: "Example News", url: "https://example.com/model-feature" }],
    },
  ];
  const requests: ScriptCompletionParams[] = [];
  const completionClient: ScriptCompletionClient = {
    async create(params) {
      requests.push(params);
      if (params.model === "primary/model") {
        return {
          id: "primary-empty",
          object: "chat.completion",
          model: params.model,
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
        };
      }
      return {
        id: "fallback-ok",
        object: "chat.completion",
        model: params.model,
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                intro: ["Here is the setup.", "Here is why it matters."],
                segments: [
                  {
                    title: "Top Story: A model ships a useful feature",
                    chunks: ["A concise segment.", "The practical takeaway is simple."],
                    sourceUrls: ["https://example.com/model-feature"],
                  },
                ],
                outro: ["That is the pattern.", "That is the useful lens."],
              }),
            },
          },
        ],
      };
    },
  };

  const episode = await writeScript("2026-05-16", clusters, {
    completionClient,
    retryBaseMs: 0,
  });

  assert.equal(episode.segments.length, 1);
  assert.deepEqual(
    requests.map((request) => request.model),
    ["primary/model", "primary/model", "primary/model", "fallback/model"],
  );
  for (const request of requests) {
    assert.equal(request.max_tokens, 8000);
    assert.equal(request.stream, false);
    assert.deepEqual(request.provider, { require_parameters: true });
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function assertNoArrayMinItemsAboveOne(schema: unknown, path = "schema"): void {
  if (!schema || typeof schema !== "object") return;

  const node = schema as Record<string, unknown>;
  if (node.type === "array" && typeof node.minItems === "number") {
    assert.ok(
      node.minItems <= 1,
      `${path}.minItems must be 0, 1, or omitted for Bedrock structured output compatibility`,
    );
  }

  for (const [key, value] of Object.entries(node)) {
    assertNoArrayMinItemsAboveOne(value, `${path}.${key}`);
  }
}
