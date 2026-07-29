---
title: Podcast feed soundbite titles must not use String.replace backreferences
module: publish
tags: [rss, podcast, soundbite, regex]
problem_type: data_corruption
---

# Podcast feed soundbite titles must not use String.replace backreferences

## Symptom

`docs/feed.xml` contained malformed `<podcast:soundbite>` entries when a chapter/soundbite title included currency text like `$1.5` or `$1 Billion`. The soundbite body expanded into a copy of the episode `<guid>`, `<pubDate>`, `<description>`, and enclosure markup.

## Root cause

`injectItunesTags()` built iTunes/Podcasting 2.0 item tags with `String.replace(regex, replacementString)`. In JavaScript replacement strings, `$1` is a capture-group backreference. Dynamic soundbite titles that contain `$1…` were therefore expanded into the first capture group (the item XML prefix).

## Fix

Use a function replacer so dynamic `$` characters are treated as literal text. Rebuild the feed from on-disk episode sidecars after the fix (`rebuildFeed()`).

## Regression coverage

`test/publish.soundbite-dollar.test.ts` publishes an episode whose segment title includes `$1.5` and asserts the soundbite text stays literal with no nested XML.
