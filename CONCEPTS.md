# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Episode generation

### Episode
A single day's published podcast program — the spoken audio plus its companion metadata (title, chapters, transcript, and the per-story curation record). One Episode is produced per weekday run and identified by its date.

### Story Cluster
A group of source articles judged to be about the same underlying story, collapsed into one unit with a single headline, a "why it matters" note, a caveat, source list, and an Importance score. Curation deduplicates the day's articles into Story Clusters and then selects which ones air.

### canonicalKey
The stable, kebab-case identity of a Story Cluster (e.g. a slug naming the story). It is what lets the pipeline recognize the *same* story across different days, and so is the join key behind the Curation Ledger and Follow-up detection.

### Importance
A 0–100 audience-impact score assigned to each Story Cluster during curation. It drives both selection (which stories clear the bar and air) and narration depth (how much time a story gets). State the behavior, not the cutoff — the threshold and story cap are configuration.

### Curated show notes
The human-readable episode description written into `feed.xml` (and the sidecar). Built at publish time from the selected Story Clusters: HTML story cards (`<p>` + publisher-named `<a>` links) with the segment title, why-it-matters, caveat, and sources, followed by a contiguous `HH:MM:SS Title` chapter list so Apple Podcasts / Spotify / YouTube can parse jumpable chapters. Not a catalog deep link — Apple has not assigned an episode ID at publish time.

## Fetch & pipeline guards

### URL canonicalization
Normalizing an article link before fetch-level dedup: strip the fragment, drop tracking query params (`utm_*`, `fbclid`, `gclid`, and similar), and sort remaining query keys. Two syndication URLs that differ only by click-ids resolve to the same key.

### Fetch deduplication
Collapsing identical (or tracking-variant) article URLs across feeds **before** curation, keeping the first occurrence. Distinct from Story Cluster dedup: this is a cheap URL-key pass so the LLM does not score the same link twice; clustering still merges different URLs about the same story.

### Preflight
A fail-fast config/runtime check run before paid pipeline stages. Validates required API keys for the active TTS route, that `FEED_BASE_URL` is an absolute `http(s)` URL, and that `ffmpeg`/`ffprobe` are on PATH. Invoked automatically by `npm start` and manually via `npm run preflight`. Does not call OpenRouter, OpenAI, or RSS.

### Already-published skip
Early pipeline exit when today's sidecar JSON and MP3 both already exist under `docs/episodes/`. Used so the backup cron (and same-day re-dispatch) does not re-spend LLM/TTS quota after a successful primary run. Distinct from retention pruning.

## Cross-episode memory

### Curation Ledger
A rolling, recent-history record of stories that have already aired, read by the curate step so it can reason about prior coverage instead of starting cold each day. It is what makes suppression and threading possible.

### Follow-up
A Story Cluster that is a development of something already covered, aired as a continuation ("the rumor we flagged earlier is now confirmed") rather than introduced fresh. Distinct from a new story and from a suppressed one.
*Avoid:* echo, repeat.

### Suppression
Dropping a Story Cluster from an Episode because it was already covered and has not materially developed, freeing its slot for genuinely new stories. The opposite outcome to a Follow-up for a recurring story.

## Script voice & anti-repetition

### Style snippets
Intro-opener, outro-opener, and sign-off excerpts parsed from recent on-disk transcripts (`YYYY-MM-DD.transcript.txt`). The script step loads the last ~8 prior episodes via `loadRecentStyleSnippets` and injects them as a **RECENTLY USED** do-not-reuse block so openings, closings, and farewells do not recycle yesterday's phrasing. Zero extra API calls; included in the script stage-cache key. Distinct from the Curation Ledger (story coverage vs prose shape).

### Intro / outro move
A deterministic per-day structural instruction for how the opening or closing should be shaped (`INTRO_MOVES` / `OUTRO_MOVES` in `src/script.ts`), selected by a salted `stableHash` of the episode date so it rotates independently of the daily persona. Prescribing a different *move* each day reduces collapse into one outro mold when the model is only told "write something fresh."

### Outro mold validator
Hard-fail regex checks on the generated closing (e.g. "pull/step/zoom back" openers, "a pattern emerges", "Keep your X and your Y", "That's the {bulletin} for {date}"). A hit rejects the script attempt so the model can re-roll (3 attempts per model). Soft bans for announced-beat tics live in `BANNED_SCRIPT_PHRASES` instead.

## Publish & hosting

### Publish verification
Post-push check that today's episode GUID is actually present in the **live** public `feed.xml` (GitHub Pages deploy), not merely committed in git. Polls the feed, may push an empty commit to unstick a queued deploy, and fails the workflow (with a healthcheck fail ping) if the episode never appears. Turns the backup cron into a recovery path even when generation was skipped.
