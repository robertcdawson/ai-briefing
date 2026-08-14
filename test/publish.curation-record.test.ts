import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadAllRecords } from "../src/publish.js";
import type { StoryCluster, CurationRecord } from "../src/types.js";

// F2: hermetic test — no writes to real docs/ paths, no module-level fs reads.
// Tests the curation record construction/serialization by writing sidecars to a
// temp dir and reading them back via loadAllRecords.

function makeCluster(key: string, overrides: Partial<StoryCluster> = {}): StoryCluster {
  return {
    canonicalKey: key,
    category: "research",
    headline: `Headline for ${key}`,
    whyItMatters: `Why ${key} matters`,
    caveat: `Caveat for ${key}`,
    importance: 75,
    sources: [{ url: `https://example.com/${key}`, publisher: "Example" }],
    ...overrides,
  };
}

/**
 * Mirrors the curation serialization logic from publish() without invoking
 * publish()'s full side-effects (audio copy, feed.xml write, etc.). `stances`
 * mirrors the positional join against episode.segments[i]?.stance in the
 * real implementation — index i's entry, if any, becomes cluster i's stance.
 */
function buildCurationArray(
  clusters: StoryCluster[],
  stances: (string | undefined)[] = [],
): CurationRecord[] | undefined {
  if (clusters.length === 0) return undefined;
  return clusters.map((c, i) => ({
    canonicalKey: c.canonicalKey,
    headline: c.headline,
    whyItMatters: c.whyItMatters,
    caveat: c.caveat,
    importance: c.importance,
    category: c.category,
    stance: stances[i],
    specifics: c.specifics,
  }));
}

function buildSidecar(
  date: string,
  curation: CurationRecord[] | undefined,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    date,
    title: `AI Briefing — ${date}`,
    description: "Test episode",
    durationSeconds: 300,
    byteLength: 1024,
    pubDate: new Date().toISOString(),
    season: Number(date.slice(0, 4)),
    episodeNumber: 1,
  };
  if (curation !== undefined) {
    record["curation"] = curation;
  }
  return record;
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "pub-curation-test-"));
}

// ---------------------------------------------------------------------------
// Test 1: 3 aired clusters → sidecar with curation array of 3 entries
// ---------------------------------------------------------------------------
test("episode with 3 aired clusters produces sidecar with curation array of 3 entries", async () => {
  const dir = await makeTempDir();
  try {
    const date = "2099-06-17";
    const clusters: StoryCluster[] = [
      makeCluster("ai-model-breakthrough", { importance: 90, category: "research" }),
      makeCluster("new-ai-product-launch", { importance: 70, category: "product-tools" }),
      makeCluster("funding-round-closed", { importance: 60, category: "business" }),
    ];

    const curation = buildCurationArray(clusters);
    const sidecar = buildSidecar(date, curation);
    await writeFile(path.join(dir, `${date}.json`), JSON.stringify(sidecar, null, 2), "utf8");

    const raw = await readFile(path.join(dir, `${date}.json`), "utf8");
    const record = JSON.parse(raw);

    assert.ok(Array.isArray(record.curation), "curation field must be an array");
    assert.equal(record.curation.length, 3, "curation must have exactly 3 entries");

    assert.equal(record.curation[0].canonicalKey, "ai-model-breakthrough");
    assert.equal(record.curation[0].importance, 90);
    assert.equal(record.curation[0].category, "research");

    assert.equal(record.curation[1].canonicalKey, "new-ai-product-launch");
    assert.equal(record.curation[1].importance, 70);
    assert.equal(record.curation[1].category, "product-tools");

    assert.equal(record.curation[2].canonicalKey, "funding-round-closed");
    assert.equal(record.curation[2].importance, 60);
    assert.equal(record.curation[2].category, "business");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2: no aired clusters → sidecar without curation field
// ---------------------------------------------------------------------------
test("episode with no aired clusters produces sidecar without curation field (field optional)", async () => {
  const dir = await makeTempDir();
  try {
    const date = "2099-06-18";
    const curation = buildCurationArray([]);
    assert.equal(curation, undefined, "buildCurationArray([]) must return undefined");

    const sidecar = buildSidecar(date, curation);
    await writeFile(path.join(dir, `${date}.json`), JSON.stringify(sidecar, null, 2), "utf8");

    const raw = await readFile(path.join(dir, `${date}.json`), "utf8");
    const record = JSON.parse(raw);

    // Field must be absent, not null or empty array
    assert.equal(
      Object.prototype.hasOwnProperty.call(record, "curation"),
      false,
      "curation must be absent when no clusters were aired",
    );

    // Sidecar is valid JSON with required fields
    assert.equal(typeof record.date, "string");
    assert.equal(typeof record.title, "string");
    assert.equal(typeof record.durationSeconds, "number");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3: canonicalKey is preserved exactly (kebab slug not mutated)
// ---------------------------------------------------------------------------
test("canonicalKey is preserved exactly (kebab slug not mutated)", async () => {
  const dir = await makeTempDir();
  try {
    const date = "2099-06-19";
    const exactKey = "openai-gpt-5-release-confirmed-2026";
    const clusters: StoryCluster[] = [
      makeCluster(exactKey, { importance: 85, category: "product-tools" }),
    ];

    const curation = buildCurationArray(clusters);
    const sidecar = buildSidecar(date, curation);
    await writeFile(path.join(dir, `${date}.json`), JSON.stringify(sidecar, null, 2), "utf8");

    const raw = await readFile(path.join(dir, `${date}.json`), "utf8");
    const record = JSON.parse(raw);

    assert.ok(Array.isArray(record.curation), "curation must be present");
    assert.equal(record.curation.length, 1);
    assert.equal(
      record.curation[0].canonicalKey,
      exactKey,
      "canonicalKey must be stored verbatim without any transformation",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F12-test: round-trip test via loadAllRecords — field fidelity check
// ---------------------------------------------------------------------------
test("round-trip: EpisodeRecord with curation array survives loadAllRecords field fidelity", async () => {
  const dir = await makeTempDir();
  try {
    const date = "2099-06-20";
    const clusters: StoryCluster[] = [
      makeCluster("round-trip-key", { importance: 77, category: "open-source" }),
      makeCluster("round-trip-key-2", { importance: 55, category: "policy-regulation" }),
    ];

    const curation = buildCurationArray(clusters);
    const sidecar = buildSidecar(date, curation);
    await writeFile(path.join(dir, `${date}.json`), JSON.stringify(sidecar, null, 2), "utf8");

    // Read back via loadAllRecords (the same path used by loadRecentCoverage)
    const records = await loadAllRecords(dir);
    assert.equal(records.length, 1, "one record loaded");

    const record = records[0]!;
    assert.equal(record.date, date);
    assert.ok(Array.isArray(record.curation), "curation must be an array");
    assert.equal(record.curation!.length, 2);

    const cr0 = record.curation![0]!;
    assert.equal(cr0.canonicalKey, "round-trip-key");
    assert.equal(cr0.category, "open-source");
    assert.equal(cr0.importance, 77);

    const cr1 = record.curation![1]!;
    assert.equal(cr1.canonicalKey, "round-trip-key-2");
    assert.equal(cr1.category, "policy-regulation");
    assert.equal(cr1.importance, 55);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Stance: an aired story's recorded stance round-trips through the sidecar;
// a story with no stance leaves the field absent (additive-optional).
// ---------------------------------------------------------------------------
test("round-trip: a segment's recorded stance persists; a story with no stance stays absent", async () => {
  const dir = await makeTempDir();
  try {
    const date = "2099-06-22";
    const clusters: StoryCluster[] = [
      makeCluster("story-with-stance", { importance: 82, category: "research" }),
      makeCluster("story-without-stance", { importance: 60, category: "business" }),
    ];

    const curation = buildCurationArray(clusters, ["I called this correctly.", undefined]);
    const sidecar = buildSidecar(date, curation);
    await writeFile(path.join(dir, `${date}.json`), JSON.stringify(sidecar, null, 2), "utf8");

    const records = await loadAllRecords(dir);
    const record = records[0]!;
    const cr0 = record.curation![0]!;
    const cr1 = record.curation![1]!;

    assert.equal(cr0.canonicalKey, "story-with-stance");
    assert.equal(cr0.stance, "I called this correctly.");

    assert.equal(cr1.canonicalKey, "story-without-stance");
    assert.equal(cr1.stance, undefined);
    assert.equal(
      Object.prototype.hasOwnProperty.call(cr1, "stance"),
      false,
      "stance must be absent, not null, when the segment had no take",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Specifics: a cluster's extracted specifics round-trip through the sidecar;
// a story with none leaves the field absent (additive-optional).
// ---------------------------------------------------------------------------
test("round-trip: a cluster's specifics persist; a story with none stays absent", async () => {
  const dir = await makeTempDir();
  try {
    const date = "2099-06-23";
    const clusters: StoryCluster[] = [
      makeCluster("story-with-specifics", {
        importance: 82,
        category: "research",
        specifics: ["Revenue grew 40% year over year.", "CTO Jane Doe confirmed the rollout."],
      }),
      makeCluster("story-without-specifics", { importance: 60, category: "business" }),
    ];

    const curation = buildCurationArray(clusters);
    const sidecar = buildSidecar(date, curation);
    await writeFile(path.join(dir, `${date}.json`), JSON.stringify(sidecar, null, 2), "utf8");

    const records = await loadAllRecords(dir);
    const record = records[0]!;
    const cr0 = record.curation![0]!;
    const cr1 = record.curation![1]!;

    assert.equal(cr0.canonicalKey, "story-with-specifics");
    assert.deepEqual(cr0.specifics, [
      "Revenue grew 40% year over year.",
      "CTO Jane Doe confirmed the rollout.",
    ]);

    assert.equal(cr1.canonicalKey, "story-without-specifics");
    assert.equal(cr1.specifics, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// M3: curationReport persists alongside (and independently of) the M1 curation field
// ---------------------------------------------------------------------------
test("round-trip: curationReport (full audit) persists alongside the M1 curation field", async () => {
  const dir = await makeTempDir();
  try {
    const date = "2099-06-21";
    const curation = buildCurationArray([
      makeCluster("aired-key", { importance: 80, category: "research" }),
    ]);
    const curationReport = {
      threshold: 45,
      maxStories: 6,
      total: 2,
      selectedCount: 1,
      droppedCount: 1,
      clusters: [
        { canonicalKey: "aired-key", category: "research", headline: "H1", importance: 80, selected: true },
        {
          canonicalKey: "dropped-key",
          category: "business",
          headline: "H2",
          importance: 30,
          selected: false,
          dropReason: "below_threshold",
        },
      ],
    };
    const sidecar = buildSidecar(date, curation);
    sidecar["curationReport"] = curationReport;
    await writeFile(path.join(dir, `${date}.json`), JSON.stringify(sidecar, null, 2), "utf8");

    const records = await loadAllRecords(dir);
    const record = records[0]!;

    // M1 field unchanged...
    assert.ok(Array.isArray(record.curation), "curation (aired) must still be present");
    assert.equal(record.curation!.length, 1);

    // ...and the full M3 audit persists, including the dropped story + reason.
    assert.ok(record.curationReport, "curationReport must be present");
    assert.equal(record.curationReport!.droppedCount, 1);
    assert.equal(record.curationReport!.clusters.length, 2);
    const dropped = record.curationReport!.clusters.find((c) => !c.selected)!;
    assert.equal(dropped.canonicalKey, "dropped-key");
    assert.equal(dropped.dropReason, "below_threshold");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
