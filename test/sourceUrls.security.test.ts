import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import OpenAI from "openai";
import Parser from "rss-parser";
import { fetchAll } from "../src/fetch.js";
import { curate } from "../src/curate.js";
import { publish } from "../src/publish.js";
import type { Article, Episode } from "../src/types.js";

const unsafeUrls = [
  "javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)",
  "java\nscript:alert(1)", "\u0000javascript:alert(1)", "data:text/html,<script>alert(1)</script>",
  "file:///etc/passwd", "//example.com/story", "/story", "not a URL",
  "https://", "https://example.com:bad/story", "https://exa\nmple.com/story",
  "https:example.com/story", "https://example.com\\story",
  "https:///example.com/story", "https:////example.com/story", " https://example.com/story\t",
];
const safeUrls = ["https://example.com/story?a=1&b=%22quote%22#details", "HTTP://example.org/news"];

function episode(sourceUrls: string[]): Episode {
  return {
    date: new Date().toISOString().slice(0, 10), title: "Security fixture",
    intro: ["Intro"], outro: ["Outro"],
    segments: [{ title: "Story", chunks: ["Story text"], sourceUrls }],
    audioPath: "", byteLength: 0, durationSeconds: 0,
  };
}

test("RSS ingestion drops unsafe source URLs and preserves valid links", async (t) => {
  const xml = `<rss version="2.0"><channel><title>Fixture</title>${[...unsafeUrls, ...safeUrls]
    .filter((url) => !url.includes("\u0000")) // NUL is not legal XML.
    .map((url) => `<item><title>Story</title><link><![CDATA[${url}]]></link><pubDate>${new Date().toUTCString()}</pubDate></item>`)
    .join("")}</channel></rss>`;
  t.mock.method(globalThis, "fetch", async () => new Response(xml));
  assert.deepEqual((await fetchAll()).map((a) => a.url), safeUrls);
});

test("curation rejects invented or unsafe URLs and resolves valid publishers from fetched articles", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });
  let urls = ["https://invented.example/story"];
  t.mock.method(OpenAI.Chat.Completions.prototype, "create", async () => ({
    choices: [{ message: { content: JSON.stringify({ clusters: [{
      canonicalKey: "story", category: "research", headline: "Story", whyItMatters: "Useful",
      caveat: "Early", importance: 80, sources: urls.map((url) => ({ url, publisher: "Model invention" })),
    }] }) } }],
  }));
  const articles: Article[] = safeUrls.map((url) => ({
    url, source: "Trusted & <Publisher>", title: "Story", excerpt: "Details", publishedAt: new Date().toISOString(),
  }));
  for (const url of ["https://invented.example/story", ...unsafeUrls, `${safeUrls[0]}-invented`]) {
    urls = [url];
    await assert.rejects(curate(articles), /source URL/i, url);
  }
  urls = ["javascript:alert(1)"];
  await assert.rejects(curate([{ ...articles[0]!, url: urls[0]! }]), /source URL/i);
  urls = safeUrls.map((url) => ` ${url} `);
  const result = await curate(articles);
  assert.deepEqual(result.selected[0]!.sources, articles.map((a) => ({ url: a.url, publisher: a.source })));
});

test("publication rejects unsafe sources before writing and preserves safe anchors through RSS serialization", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "source-url-test-"));
  const previousCwd = process.cwd();
  const previousBase = process.env.FEED_BASE_URL;
  t.after(async () => {
    process.chdir(previousCwd);
    if (previousBase === undefined) delete process.env.FEED_BASE_URL;
    else process.env.FEED_BASE_URL = previousBase;
    await rm(dir, { recursive: true, force: true });
  });
  process.chdir(dir);
  process.env.FEED_BASE_URL = "https://podcast.example";
  await writeFile("input.mp3", "fixture audio");
  for (const url of unsafeUrls) {
    await assert.rejects(publish(episode([url]), "input.mp3", 13, 60, [], [], undefined, { prune: false }), /source URL/i, url);
    assert.deepEqual(await readdir(dir), ["input.mp3"], "rejected input must not write partial episode assets");
  }
  const ep = episode(safeUrls.map((url) => ` ${url} `));
  await publish(ep, "input.mp3", 13, 60, [], [{
    canonicalKey: "story", category: "research", headline: "Story", whyItMatters: "Useful", caveat: "Early",
    sources: safeUrls.map((url) => ({ url, publisher: 'Publisher & <News> "quoted"' })),
  }], undefined, { prune: false });
  const sidecar = JSON.parse(await readFile(`docs/episodes/${ep.date}.json`, "utf8"));
  const feed = await new Parser().parseString(await readFile("docs/feed.xml", "utf8"));
  assert.equal(feed.items[0]!.content, sidecar.description);
  assert.ok(sidecar.description.includes(`href="https://example.com/story?a=1&amp;b=%22quote%22#details"`));
  assert.ok(sidecar.description.includes(`href="HTTP://example.org/news"`));
  assert.ok(sidecar.description.includes('Publisher &amp; &lt;News&gt; "quoted"'));
});
