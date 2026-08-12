---
title: Episode descriptions use HTML story cards and a trailing Apple-parseable chapter list
date: 2026-08-12
category: docs/solutions/best-practices
module: publish
problem_type: best_practice
component: src/publish.ts
severity: low
applies_when:
  - Changing episode show notes, RSS <description>, or chapter timestamps
  - Adding links that should open in Apple Podcasts or other podcast apps
  - Debugging why Apple Podcasts chapters do or do not appear
tags: [publish, rss, apple-podcasts, chapters, show-notes, html]
---

# Episode descriptions use HTML story cards and a trailing Apple-parseable chapter list

## Context

Apple Podcasts (iOS 26.2+) reads chapters from three places: timestamps in the episode description, Podcasting 2.0 `<podcast:chapters>` JSON, and MP3 ID3 tags. This pipeline already publishes the JSON sidecar and ID3 chapters. The RSS `<description>` is what listeners see as show notes, and Apple also parses a contiguous `HH:MM:SS Title` list from it (first chapter at `00:00:00`, at least three chapters).

Apple's **timed links** are a different feature: banners to Apple catalog items (Music, News, TV, other podcasts). They are not chapter-seek links. Share URLs with `&t=` / `&r=` require Apple's catalog episode ID (`?i=…`), which does not exist at `publish()` time.

## Decision

`buildEpisodeDescription()` writes a safe HTML subset Apple still renders in `<description>` CDATA:

- `<p>` for spacing (not `<br>`, which Apple has stripped)
- `<a href>` with publisher names for source links
- LLM/source text escaped (`&`, `<`, `>`)
- No per-item `<itunes:summary>` (Apple has historically shown that instead of the HTML description)

Story cards come first (title, why-it-matters, caveat, sources). A single chapter TOC comes last so Apple/Spotify/YouTube parsers see one timestamp list. Story cards do not repeat `HH:MM:SS` lines — a second copy would risk duplicate parsed chapters.

## Consequences

- Listeners jump chapters in Apple Podcasts via the native chapter list / scrubber, not by tapping a `podcasts.apple.com` URL.
- Source URLs that are not Apple catalog items will not appear as timed-link banners.
- Already-published sidecar `description` fields are not rewritten; they age out of the 14-item feed.
