import assert from "node:assert/strict";
import test from "node:test";
import {
  DAILY_PERSONAS,
  SCRIPT_RESPONSE_SCHEMA,
  buildSystemPrompt,
  buildUserPrompt,
  resolveScriptModel,
  resolveScriptModels,
  resolveScriptTimeoutMs,
  selectDailyPersona,
  validateScriptResponse,
  writeScript,
} from "../src/script.js";
import type { ScriptCompletionClient, ScriptCompletionParams } from "../src/script.js";
import type { StoryCluster } from "../src/types.js";

test("resolveScriptModels defaults to ordered structured-output-compatible OpenRouter models", () => {
  assert.deepEqual(
    resolveScriptModels(undefined),
    ["openai/gpt-4o-mini", "google/gemini-3.1-pro-preview"],
  );
  assert.deepEqual(
    resolveScriptModels(""),
    ["openai/gpt-4o-mini", "google/gemini-3.1-pro-preview"],
  );
  assert.deepEqual(
    resolveScriptModels("   "),
    ["openai/gpt-4o-mini", "google/gemini-3.1-pro-preview"],
  );
  assert.ok(!resolveScriptModels(undefined).includes("anthropic/claude-sonnet-4.6"));
  assert.notDeepEqual(resolveScriptModels(undefined), ["anthropic/claude-opus-4.6"]);
  assert.notDeepEqual(resolveScriptModels(undefined), ["anthropic/claude-opus-4.7"]);
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
  assert.equal(resolveScriptModel(undefined), "openai/gpt-4o-mini");
  assert.equal(resolveScriptModel(""), "openai/gpt-4o-mini");
  assert.equal(resolveScriptModel("   "), "openai/gpt-4o-mini");
  assert.equal(
    resolveScriptModel(" anthropic/claude-sonnet-4.6 "),
    "anthropic/claude-sonnet-4.6",
  );
  assert.equal(resolveScriptModel(" primary/model, fallback/model "), "primary/model");
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

test("selectDailyPersona is stable for the same episode date", () => {
  const first = selectDailyPersona("2026-05-11");
  const second = selectDailyPersona("2026-05-11");

  assert.equal(second.name, first.name);
});

test("selectDailyPersona rotates across dates", () => {
  const selectedNames = new Set(
    [
      "2026-05-11",
      "2026-05-12",
      "2026-05-13",
      "2026-05-14",
      "2026-05-15",
    ].map((date) => selectDailyPersona(date).name),
  );

  assert.ok(selectedNames.size > 1, "date-based selection should vary the delivery persona");
});

test("buildSystemPrompt keeps persona style bounded by factual constraints", () => {
  const persona = DAILY_PERSONAS[0];
  assert.ok(persona, "at least one daily persona must be configured");

  const prompt = buildSystemPrompt(persona);

  assert.match(prompt, new RegExp(`Persona: ${escapeRegExp(persona.name)}`));
  assert.match(prompt, /style lens, not a character bit/);
  assert.match(prompt, /strong opinions/);
  assert.match(prompt, /grounded in the provided facts/);
  assert.match(prompt, /No celebrity impressions/);
  assert.match(prompt, /Do not invent .* facts/);
  assert.match(prompt, /sourceUrls MUST be exactly the urls provided/);
  assert.match(prompt, /two-speaker exchange/);
  assert.match(prompt, /anchor: The Anchor/);
  assert.match(prompt, /analyst: The Analyst/);
  assert.match(prompt, /do not put speaker names inside the text/);
});

test("buildUserPrompt preserves source publisher and URL context", () => {
  const clusters: StoryCluster[] = [
    {
      canonicalKey: "test-story",
      category: "product-tools",
      headline: "A model ships a useful feature",
      whyItMatters: "Builders get a simpler path to production.",
      caveat: "Benchmarks are still early.",
      sources: [
        { publisher: "Example News", url: "https://example.com/model-feature" },
      ],
    },
  ];

  const prompt = buildUserPrompt("2026-05-11", clusters);

  assert.match(prompt, /Today is 2026-05-11/);
  assert.match(prompt, /STORY 1: A model ships a useful feature/);
  assert.match(prompt, /Category: Product & Tool Watch \(product-tools\)/);
  assert.match(prompt, /Example News: https:\/\/example\.com\/model-feature/);
});

test("buildSystemPrompt enforces hook, labels, concise transitions, pacing, and explainers", () => {
  const persona = DAILY_PERSONAS[0];
  assert.ok(persona, "at least one daily persona must be configured");

  const prompt = buildSystemPrompt(persona);

  assert.match(prompt, /Begin with an engaging summary hook/);
  assert.match(prompt, /exactly one segment per provided story cluster/);
  assert.match(prompt, /If fewer than three credible clusters are provided/);
  assert.match(prompt, /first segment title MUST begin "Top Story:/);
  assert.match(prompt, /Product & Tool Watch: \{headline\}/);
  assert.match(prompt, /smooth, short transition/);
  assert.match(prompt, /under about 12 words/);
  assert.match(prompt, /most sentences under about 24 words/);
  assert.match(prompt, /define specialized terms in 8-14 plain words/);
  assert.match(prompt, /TTS-friendly prosody/);
  assert.match(prompt, /commas for natural breath pauses/);
  assert.match(prompt, /one rhetorical question per segment at most/);
  assert.match(prompt, /never announcer-y or fake-enthusiastic/);
  assert.match(prompt, /both speakers throughout the episode/);
});

test("SCRIPT_RESPONSE_SCHEMA requires structured speaker turns", () => {
  const schema = SCRIPT_RESPONSE_SCHEMA;
  assert.equal(schema.properties.intro.type, "array");
  assert.equal(schema.properties.outro.type, "array");
  assert.equal(schema.properties.segments.items.properties.turns.type, "array");
  assert.deepEqual(
    schema.properties.segments.items.properties.turns.items.required,
    ["speaker", "text"],
  );
  assertNoArrayMinItemsAboveOne(schema);
  assert.equal("minLength" in schema.properties.segments.items.properties.title, false);
  assert.equal("pattern" in schema.properties.segments.items.properties.title, false);
  assert.equal(
    "minLength" in schema.properties.segments.items.properties.turns.items.properties.text,
    false,
  );
  assert.equal(
    "pattern" in schema.properties.segments.items.properties.turns.items.properties.text,
    false,
  );
  assert.deepEqual(
    schema.properties.segments.items.properties.turns.items.properties.speaker.enum,
    ["anchor", "analyst"],
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
      intro: [
        { speaker: "anchor", text: "Here is the setup." },
        { speaker: "analyst", text: "And here is why it matters." },
      ],
      segments: [
        {
          title: "Top Story: A model ships a useful feature",
          turns: [
            { speaker: "anchor", text: "A concise segment." },
            { speaker: "analyst", text: "The practical takeaway is simple." },
          ],
          sourceUrls: [
            " https://example.com/model-feature-details ",
            "https://example.com/model-feature",
          ],
        },
      ],
      outro: [
        { speaker: "anchor", text: "That is the pattern." },
        { speaker: "analyst", text: "And that is the useful lens." },
      ],
    },
    clusters,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: [
            { speaker: "anchor", text: "Here is the setup." },
            { speaker: "analyst", text: "Here is the so what." },
          ],
          segments: [],
          outro: [
            { speaker: "anchor", text: "That is the pattern." },
            { speaker: "analyst", text: "That is the lens." },
          ],
        },
        clusters,
      ),
    /expected 1/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: [
            { speaker: "anchor", text: "Here is the setup." },
            { speaker: "analyst", text: "Here is the so what." },
          ],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              turns: [
                { speaker: "anchor", text: "A concise segment." },
                { speaker: "analyst", text: "The practical takeaway is simple." },
              ],
              sourceUrls: ["https://example.com/changed"],
            },
          ],
          outro: [
            { speaker: "anchor", text: "That is the pattern." },
            { speaker: "analyst", text: "That is the lens." },
          ],
        },
        clusters,
      ),
    /sourceUrls do not match.*missing=.*model-feature.*extra=.*changed/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: [
            { speaker: "anchor", text: "Here is the setup." },
            { speaker: "analyst", text: "Here is the so what." },
          ],
          outro: [
            { speaker: "anchor", text: "That is the pattern." },
            { speaker: "analyst", text: "That is the lens." },
          ],
        } as unknown as Parameters<typeof validateScriptResponse>[0],
        clusters,
      ),
    /segments must be an array/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: [
            { speaker: "anchor", text: "Here is the setup." },
            { speaker: "analyst", text: "Here is the so what." },
          ],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              turns: [
                { speaker: "anchor", text: "A concise segment." },
                { speaker: "analyst", text: "The practical takeaway is simple." },
              ],
            },
          ],
          outro: [
            { speaker: "anchor", text: "That is the pattern." },
            { speaker: "analyst", text: "That is the lens." },
          ],
        } as unknown as Parameters<typeof validateScriptResponse>[0],
        clusters,
      ),
    /sourceUrls must be an array/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: [
            { speaker: "anchor", text: "Here is the setup." },
            { speaker: "analyst", text: "Here is the so what." },
          ],
          segments: [
            {
              title: " ",
              turns: [
                { speaker: "anchor", text: "A concise segment." },
                { speaker: "analyst", text: "The practical takeaway is simple." },
              ],
              sourceUrls: ["https://example.com/model-feature"],
            },
          ],
          outro: [
            { speaker: "anchor", text: "That is the pattern." },
            { speaker: "analyst", text: "That is the lens." },
          ],
        },
        clusters,
      ),
    /title must be a non-empty string/,
  );
});

test("validateScriptResponse rejects malformed speaker turns", () => {
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
              turns: [
                { speaker: "anchor", text: "A concise segment." },
                { speaker: "analyst", text: "The practical takeaway is simple." },
              ],
              sourceUrls: ["https://example.com/model-feature"],
            },
          ],
          outro: [
            { speaker: "anchor", text: "That is the pattern." },
            { speaker: "analyst", text: "That is the lens." },
          ],
        },
        clusters,
      ),
    /intro turns must include at least 2 turns/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: [
            { speaker: "producer", text: "Here is the setup." },
            { speaker: "analyst", text: "Here is the so what." },
          ],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              turns: [
                { speaker: "anchor", text: "A concise segment." },
                { speaker: "analyst", text: "The practical takeaway is simple." },
              ],
              sourceUrls: ["https://example.com/model-feature"],
            },
          ],
          outro: [
            { speaker: "anchor", text: "That is the pattern." },
            { speaker: "analyst", text: "That is the lens." },
          ],
        } as unknown as Parameters<typeof validateScriptResponse>[0],
        clusters,
      ),
    /speaker must be "anchor" or "analyst"/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: [
            { speaker: "anchor", text: "Here is the setup." },
            { speaker: "analyst", text: "Here is the so what." },
          ],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              turns: [{ speaker: "anchor", text: "A concise segment." }],
              sourceUrls: ["https://example.com/model-feature"],
            },
          ],
          outro: [
            { speaker: "anchor", text: "That is the pattern." },
            { speaker: "analyst", text: "That is the lens." },
          ],
        },
        clusters,
      ),
    /segment 1 turns must include at least 2 turns/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: [
            { speaker: "anchor", text: "Here is the setup." },
            { speaker: "analyst", text: "Here is the so what." },
          ],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              turns: [
                { speaker: "anchor", text: "A concise segment." },
                { speaker: "analyst", text: "The practical takeaway is simple." },
              ],
              sourceUrls: ["https://example.com/model-feature"],
            },
          ],
          outro: [{ speaker: "anchor", text: "That is the pattern." }],
        },
        clusters,
      ),
    /outro turns must include at least 2 turns/,
  );

  assert.throws(
    () =>
      validateScriptResponse(
        {
          intro: [
            { speaker: "anchor", text: "Here is the setup." },
            { speaker: "analyst", text: "Here is the so what." },
          ],
          segments: [
            {
              title: "Top Story: A model ships a useful feature",
              turns: [
                { speaker: "anchor", text: "A concise segment." },
                { speaker: "analyst", text: " " },
              ],
              sourceUrls: ["https://example.com/model-feature"],
            },
          ],
          outro: [
            { speaker: "anchor", text: "That is the pattern." },
            { speaker: "analyst", text: "That is the lens." },
          ],
        } as unknown as Parameters<typeof validateScriptResponse>[0],
        clusters,
      ),
    /text must be a non-empty string/,
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
                intro: [
                  { speaker: "anchor", text: "Here is the setup." },
                  { speaker: "analyst", text: "Here is why it matters." },
                ],
                segments: [
                  {
                    title: "Top Story: A model ships a useful feature",
                    turns: [
                      { speaker: "anchor", text: "A concise segment." },
                      { speaker: "analyst", text: "The practical takeaway is simple." },
                    ],
                    sourceUrls: ["https://example.com/model-feature"],
                  },
                ],
                outro: [
                  { speaker: "anchor", text: "That is the pattern." },
                  { speaker: "analyst", text: "That is the useful lens." },
                ],
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
    ["primary/model", "primary/model", "fallback/model"],
  );
  for (const request of requests) {
    assert.equal(request.max_tokens, 4096);
    assert.equal(request.stream, false);
    assert.deepEqual(request.provider, { require_parameters: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
