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

### Stance memory
The host's on-air judgment on a story, carried forward across episodes. The script records one sentence per segment as `stance` (nullable — purely factual segments have none), it rides the sidecar's curation record, and when the story resurfaces as a Follow-up the curator threads it back as `priorStance` so the writer can explicitly revisit it — say whether the earlier call held up, was wrong, or is still open. Distinct from Follow-up itself, which tracks that a story continues; stance memory tracks what the host said about it last time.

## Script voice & anti-repetition

### Style snippets
Intro-opener, outro-opener, and sign-off excerpts parsed from recent on-disk transcripts (`YYYY-MM-DD.transcript.txt`). The script step loads the last ~8 prior episodes via `loadRecentStyleSnippets` and injects them as a **RECENTLY USED** do-not-reuse block so openings, closings, and farewells do not recycle yesterday's phrasing. Zero extra API calls; included in the script stage-cache key. Distinct from the Curation Ledger (story coverage vs prose shape).

### Intro / outro move
A deterministic per-day structural instruction for how the opening or closing should be shaped (`INTRO_MOVES` / `OUTRO_MOVES` in `src/script.ts`), selected by a salted `stableHash` of the episode date. Prescribing a different *move* each day reduces collapse into one outro mold when the model is only told "write something fresh." Distinct from Segment shape, which does the same job for individual story segments rather than the open/close.

### Outro mold validator
Hard-fail regex checks on the generated closing (e.g. "pull/step/zoom back" openers, "a pattern emerges", "Keep your X and your Y", "That's the {bulletin} for {date}"). A hit rejects the script attempt so the model can re-roll (3 attempts per model). Soft bans for a small set of timeless announced-beat tics live in `BANNED_SCRIPT_PHRASES`, which is frozen — new phrasing drift is caught by the Phrase tripwire instead of by adding entries.

### Host identity
The single persistent host's identity — background, beat, what they care about, their humor, and what they refuse to do (hype, hedge everything equally, perform surprise, moralize) — defined once in `src/voice.ts` (`HOST_IDENTITY`) and rendered into every script prompt via `formatHostIdentityBlock()`. Replaced the five rotating `DAILY_PERSONAS`; the tonal lens is now constant across episodes instead of selected by date.

### Voice exemplars
Three to five passages from the show's own published transcripts (`VOICE_EXEMPLARS` in `src/voice.ts`), quoted into the script prompt as "the show at its best." The model is told to match their register — the flatness, the specificity, the way a judgment lands without being announced — never their wording. Curated by hand; replace with better passages as new episodes publish.

### Emphasis budget
The prompt's positive replacement for a list of banned rhetorical moves: baseline register stays flat, declarative, and specific; the script gets one deliberate rhetorical peak at its most consequential story, at most one analogy (and only if it maps to something the listener has lived), and no two consecutive sentences sharing the same rhetorical shape. Spends rhetoric like a budget instead of forbidding it outright.

### Segment shape
A deterministic per-story structural instruction (`SEGMENT_SHAPES` in `src/script.ts`, e.g. verdict-first, mystery-first, listener-objection) selected by a salted `stableHash` of the episode date and the segment index, so adjacent stories in the same episode take different shapes and the rotation itself varies day to day. Distinct from Intro / outro move, which shapes only the open and close.

### Phrase tripwire
Statistical, not enumerated, anti-repetition: `buildRecentPhraseProfile` extracts 3- and 4-word phrases from the last 8 transcripts and counts, per phrase, how many *distinct episodes* it appeared in — not raw occurrences. A phrase appearing in ≥3 of 8 is surfaced in the prompt as worn-out; one appearing in ≥4 hard-rejects the script attempt (`assertNoWornPhrases`) so it re-rolls. Replaces most of the enumeration work `BANNED_SCRIPT_PHRASES` used to do — see Outro mold validator — by catching drift from what the show has actually said recently instead of waiting for someone to notice and add an entry.

### Ear edit
A low-temperature copy-editing pass (`src/earEdit.ts`) that runs between script and TTS: the same script comes back as JSON, with only the Emphasis budget mechanically enforced — warm-up sentences and self-endorsements deleted, runs of same-shape sentences broken up, unearned triads collapsed. Non-blocking: any failure (bad JSON, a validator trip, a word-count blowout) falls back to the unedited script, so this stage can only leave an episode equal to or better than what the script stage produced. Toggle with `EAR_EDIT_ENABLED` (default on).

### Delivery hint
An optional 3-6 word per-segment spoken-delivery note (e.g. "flat — let the number speak") that the script writer attaches to a segment; `src/tts.ts` folds it into that segment's TTS instructions. OpenAI `gpt-4o-mini-tts` path only — the OpenRouter/Gemini TTS path has no delivery-instructions channel and uses inline audio tags instead. Transient: carried from script to tts, not persisted to the sidecar.

### Style report
`npm run style:report` — a read-only CLI (`scripts/style-report.ts`) that prints per-episode prose metrics (sentence-length variance, antithesis/triad/metadiscourse counts) and the top repeated 3/4-grams across recent transcripts, for checking whether the register is actually varying over time rather than just reading better on one sample episode. Reads local transcripts only; makes no API calls and always exits 0.

## Publish & hosting

### Publish verification
Post-push check that today's episode GUID is actually present in the **live** public `feed.xml` (GitHub Pages deploy), not merely committed in git. Polls the feed, may push an empty commit to unstick a queued deploy, and fails the workflow (with a healthcheck fail ping) if the episode never appears. Turns the backup cron into a recovery path even when generation was skipped.
