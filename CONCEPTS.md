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

## Cross-episode memory

### Curation Ledger
A rolling, recent-history record of stories that have already aired, read by the curate step so it can reason about prior coverage instead of starting cold each day. It is what makes suppression and threading possible.

### Follow-up
A Story Cluster that is a development of something already covered, aired as a continuation ("the rumor we flagged earlier is now confirmed") rather than introduced fresh. Distinct from a new story and from a suppressed one.
*Avoid:* echo, repeat.

### Suppression
Dropping a Story Cluster from an Episode because it was already covered and has not materially developed, freeing its slot for genuinely new stories. The opposite outcome to a Follow-up for a recurring story.
