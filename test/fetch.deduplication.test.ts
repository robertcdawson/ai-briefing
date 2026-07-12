import assert from "node:assert/strict";
import test from "node:test";
import { canonicalArticleUrl, deduplicateFetchedArticles } from "../src/fetch.js";
import type { Article } from "../src/types.js";

function article(overrides: Partial<Article>): Article {
  return {
    title: "Example story",
    source: "Example",
    url: "https://example.com/story",
    publishedAt: "2026-07-12T12:00:00.000Z",
    excerpt: "A useful story.",
    ...overrides,
  };
}

test("canonicalArticleUrl removes fragments and tracking-only URL differences", () => {
  assert.equal(
    canonicalArticleUrl("https://Example.com/story?utm_source=rss&utm_medium=email#comments"),
    "https://example.com/story",
  );
});

test("canonicalArticleUrl preserves meaningful query parameters deterministically", () => {
  assert.equal(
    canonicalArticleUrl("https://example.com/search?b=2&utm_campaign=feed&a=1"),
    "https://example.com/search?a=1&b=2",
  );
});

test("deduplicateFetchedArticles keeps the first article for a canonical URL", () => {
  const articles = [
    article({
      title: "Original",
      source: "Source A",
      url: "https://example.com/story?utm_source=rss",
    }),
    article({
      title: "Duplicate",
      source: "Source B",
      url: "https://example.com/story#comments",
    }),
    article({
      title: "Distinct",
      source: "Source C",
      url: "https://example.com/story?ref=homepage",
    }),
  ];

  const deduped = deduplicateFetchedArticles(articles);

  assert.deepEqual(
    deduped.map((item) => item.title),
    ["Original", "Distinct"],
  );
});
