# AI Briefing

A daily, fully-automated AI news podcast. Every morning at ~06:30 Pacific, GitHub Actions:

1. Pulls the last 24h of articles from a curated set of AI news RSS feeds.
2. Asks Claude (via OpenRouter) to cluster duplicates and pick the top 3 stories.
3. Asks Claude to write a 4–7 minute spoken script (intro hook → three segments → synthesis outro).
4. Synthesizes the script with OpenAI `tts-1-hd` (one MP3 per segment).
5. Concats with ffmpeg, normalizes loudness to EBU R128 (-16 LUFS), encodes 192 kbps MP3 with ID3 tags.
6. Drops the file at `docs/episodes/YYYY-MM-DD.mp3`, regenerates `docs/feed.xml`, commits, and pushes.
7. GitHub Pages serves the feed; Apple Podcasts polls and downloads.

You subscribe once via "Follow a Show by URL" on iPhone. Every morning a new episode lands on your phone before 8 AM. No daily action required.

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (Node 20, ESM) |
| Scheduler | GitHub Actions cron |
| News | Curated RSS via `rss-parser` |
| LLM | OpenRouter → `anthropic/claude-sonnet-4-7` |
| TTS | OpenAI `tts-1-hd` (direct API) |
| Audio | ffmpeg via `execa` |
| Feed | `feed` npm package + iTunes namespace patch |
| Hosting | GitHub Pages (public repo, obscure path = soft privacy) |

Estimated cost: **~$5–8/month** (OpenAI TTS dominates).

## Repo layout

```
ai-briefing/
├── .github/workflows/daily.yml   # Cron + pipeline + commit
├── src/
│   ├── index.ts                  # Orchestrator
│   ├── fetch.ts                  # RSS aggregation
│   ├── curate.ts                 # Cluster + rank top 3
│   ├── script.ts                 # Generate spoken script
│   ├── tts.ts                    # Text → MP3 chunks
│   ├── audio.ts                  # ffmpeg concat + loudnorm + ID3
│   ├── publish.ts                # Move MP3, regenerate feed.xml
│   ├── feeds.ts                  # Curated source list
│   ├── types.ts                  # Article, StoryCluster, Episode
│   └── util.ts                   # logJson, withRetry, withHardTimeout
├── test/fetch.smoke.ts           # Live-feed smoke test
├── docs/                         # GitHub Pages root
│   ├── feed.xml                  # Regenerated each run
│   └── episodes/
│       ├── YYYY-MM-DD.mp3        # The audio
│       └── YYYY-MM-DD.json       # Sidecar metadata (title, duration, bytes)
├── .env.example
├── package.json
├── tsconfig.json
├── LICENSE.md
└── README.md
```

## Initial setup

### 1. Clone and install

```bash
git clone https://github.com/USER/ai-briefing.git
cd ai-briefing
npm install
```

Requires Node 20+ and `ffmpeg` + `ffprobe` on PATH for local runs.

```bash
brew install ffmpeg          # macOS
sudo apt install ffmpeg      # Debian/Ubuntu
```

### 2. Get API keys

- **OpenRouter:** sign up at https://openrouter.ai, create a key with at least $5 credit.
- **OpenAI:** create a key at https://platform.openai.com/api-keys with billing enabled. (TTS is on the standard tier.)

### 3. Local `.env`

```bash
cp .env.example .env
# edit .env and fill in OPENROUTER_API_KEY, OPENAI_API_KEY, FEED_BASE_URL
```

`FEED_BASE_URL` is the public URL where `docs/` will be served — typically `https://USER.github.io/ai-briefing`.

### 4. Smoke test the feeds

```bash
npm test
```

This hits all sources in `src/feeds.ts` live and asserts at least one article comes back. Expected output is one JSON line per source plus a `{"phase":"smoke","status":"pass",...}` at the end. If a source 404s, the smoke test still passes — see "Maintaining the source list" below.

### 5. First end-to-end run

```bash
npm start
```

Watches the full pipeline run end to end (fetch → curate → script → tts → audio → publish). Takes ~3–5 minutes. On success:

- `docs/episodes/YYYY-MM-DD.mp3` exists and plays.
- `docs/episodes/YYYY-MM-DD.json` sidecar exists.
- `docs/feed.xml` regenerated.

Inspect the MP3 in any audio player and confirm:
- It's 4–7 minutes long.
- Loudness sounds even (no jarring jumps between segments).
- ID3 tags show `title=AI Briefing — Month D, YYYY`, `artist=AI Briefing`.

### 6. Commit and push docs/

```bash
git add docs/
git commit -m "First episode"
git push
```

### 7. Enable GitHub Pages

In the repo's GitHub Settings → Pages:

- **Source:** Deploy from a branch
- **Branch:** `main` (or whatever your default is) **/ docs** folder
- Save.

After ~30s, visit `https://USER.github.io/ai-briefing/feed.xml`. You should see your RSS XML.

### 8. Validate the feed

Paste your feed URL into https://castfeedvalidator.com. Fix anything red before subscribing on iPhone — Apple is unforgiving about malformed feeds and the cached error state can stick around.

### 9. Configure GitHub Actions

In the repo's **Settings → Secrets and variables → Actions**:

**Secrets:**
- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY`

**Variables:**
- `FEED_BASE_URL` — same as `.env`, e.g. `https://USER.github.io/ai-briefing`
- `TTS_VOICE` — `onyx` (or `alloy`, `echo`, `fable`, `nova`, `shimmer`)

Then **Settings → Actions → General → Workflow permissions** → set to "Read and write permissions" so the workflow can push the daily commit.

### 10. Trigger the first scheduled run manually

Go to **Actions → daily → Run workflow → main → Run workflow**. Watch the run; it should complete green in 3–5 minutes and push a new commit with the day's episode.

### 11. Subscribe on iPhone

1. Open **Apple Podcasts**.
2. **Library** tab → top-right **•••** menu → **Follow a Show by URL**.
3. Paste `https://USER.github.io/ai-briefing/feed.xml`.
4. Tap **Follow**.
5. Tap the show → settings gear → enable **Auto Download** and **Notify When New Episode**.

You'll have new episodes auto-downloaded overnight. Lock screen, CarPlay, AirPods, 1.5x speed all work as expected.

## Day 2+

Nothing for you to do. The cron fires at 13:30 UTC every day, the pipeline runs, the episode publishes. Apple Podcasts pulls the new feed within a couple of hours and downloads.

## Schedule drift (PST vs. PDT)

The cron is fixed at `30 13 * * *` UTC year-round. That gives:

- **PDT (mid-March → early November):** episode arrives at **06:30 PT** ✓
- **PST (early November → mid-March):** episode arrives at **05:30 PT** (one hour earlier)

Acceptable for v1 — the iPhone shows it whenever you wake up. If you want a stable 06:30 local arrival, add a second cron entry (`30 14 * * *` for PST) and remove the first during PST months. Not worth the complexity for v1.

## Retention

Two layers of expiry, both deliberate:

| Layer | Window | Behavior |
|---|---|---|
| `feed.xml` listing | Last **30 episodes** | Older episodes drop out of the RSS feed |
| Disk (and git history going forward) | Last **90 days** | Older `.mp3` and `.json` files are deleted on each run |

The 90-day disk cap prevents the repo from ballooning past GitHub's 1 GB recommendation (~5–7 MB × 365 days would otherwise be ~2 GB after a year).

**Safety belt:** the pruner never deletes a file whose date is still listed in `feed.xml`, so a retention-window misconfiguration can't break the live feed.

To change either window, edit the constants at the top of `src/publish.ts`:

```ts
const FEED_LIMIT = 30;       // episodes listed in feed.xml
const RETENTION_DAYS = 90;   // disk retention
```

Already-deleted MP3s **remain in earlier git commits** — pruning only stops new commits from carrying them. If you want to fully shrink the repo, you'd need a separate one-time `git filter-repo` pass; not part of the daily pipeline.

## Manual operations

### Trigger a run on demand

**Locally** (writes into `docs/`):
```bash
npm start
git add docs/ && git commit -m "Manual run $(date -u +%Y-%m-%d)" && git push
```

**Via GitHub Actions:** Actions tab → daily → Run workflow.

### Re-run a failed day

The workflow page has a **Re-run all jobs** button. Use it after fixing the root cause. Note: a re-run that succeeds same-day will **overwrite** that day's episode and replace the sidecar JSON — the GUID stays the same so Apple Podcasts won't re-deliver it.

### Change the voice

Set `TTS_VOICE` in Actions variables (or `.env` locally). Valid: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`. Takes effect on the next run only — past episodes remain in their original voice.

### Change the model or feed sources

Edit `src/curate.ts`/`src/script.ts` (`MODEL` constant) or `src/feeds.ts` (`SOURCES`) and push. The next scheduled run picks up the change.

### Pause the pipeline

Actions tab → daily workflow → **•••** → **Disable workflow**. Re-enable when you want it back. Or comment out the `schedule:` block.

## Maintaining the source list

Publishers move RSS paths surprisingly often. The pipeline tolerates dead feeds (skips them, logs a warning), but if too many die at once you'll get thin episodes.

**Audit cadence:** every 30–60 days, run `npm test` and look for `"status":"skipped"` lines. For each skipped source:

1. Visit the publisher's site.
2. Look for `<link rel="alternate" type="application/rss+xml">` in the page source, or try common paths (`/feed`, `/rss`, `/atom.xml`, `/feed.xml`).
3. `curl -I <candidate>` until you get a 200 with `Content-Type: application/rss+xml` (or `application/xml`/`application/atom+xml`).
4. Update the URL in `src/feeds.ts` and re-run the smoke test.
5. If the publisher truly killed RSS, drop them with a one-line comment noting the date and reason.

Two publishers were dropped at first build (May 2026):

- **Anthropic News** — no public RSS feed advertised; every common path 404s.
- **Semafor Technology** — `/api/rss/all/technology.xml` returns 404.

If they restore feeds, add them back.

## Troubleshooting

### Workflow runs but no episode shows up in Apple Podcasts

1. **Validate the feed:** https://castfeedvalidator.com. Fix any red errors.
2. **Check cache:** Apple Podcasts can take 1–24h to poll a feed. The first time you subscribe, give it up to 24h before assuming something's broken.
3. **Force refresh:** in Apple Podcasts, swipe down on the show page to pull-to-refresh.
4. **Check the GUID:** open `docs/feed.xml` and confirm each `<guid>` is `ai-briefing-YYYY-MM-DD`. If GUIDs mutate between regenerations, Apple drops the episode.
5. **Check the enclosure URL:** `curl -I <enclosure-url>` should return `200` with `Content-Type: audio/mpeg`. If it 404s, GH Pages may not be deployed yet — give it 1–2 minutes after the push.

### Episode is silent, garbled, or wrong duration

1. **ID3 tags:** `ffprobe docs/episodes/YYYY-MM-DD.mp3` — confirm title/artist/album are right.
2. **Loudness:** play it back on the same device you'd normally use; if it's noticeably quieter or louder than other podcasts, the loudnorm filter isn't working — check the `audio.ts` ffmpeg invocation.
3. **Concat seam:** listen for clicks at segment boundaries. The ffmpeg concat demuxer expects identical codec parameters; if a future TTS change emits a different sample rate, it'll click.

### Workflow fails

GitHub emails the repo owner on first failure of any workflow. Triage:

1. Open the failed run, expand **Run pipeline** step.
2. Look for the JSON log line with `"status":"error"`. The `error` field is the proximate cause; `stack` shows where.
3. Common causes:
   - **All RSS sources failed:** unusual — usually means the runner has no outbound network. Wait and re-run.
   - **OpenRouter 401:** key revoked or out of credit.
   - **OpenAI 429:** rate-limited. Wait, then re-run.
   - **OpenAI 401:** key revoked or billing lapsed.
   - **ffmpeg not found:** the apt install step failed; check the install logs.

Recovery is always: fix the root cause, then re-run the workflow. A missing day is fine — the feed remains valid and the next morning's episode publishes normally.

### Smoke test passes locally but workflow fails in CI

Almost always one of:

- A required secret/variable isn't set in GitHub (Settings → Actions).
- The runner can't reach a feed that your local machine can.
- A model ID changed on OpenRouter — pin to a working ID.

## Cost monitoring

Check both dashboards monthly:

- OpenRouter: https://openrouter.ai/settings/credits
- OpenAI: https://platform.openai.com/usage

Expected: ~$2–3 OpenRouter (curate + script ≈ 5k tokens/day), ~$3–5 OpenAI TTS (~800 chars × 5 segments × 30 days × $30/1M chars). If either spikes 5x, something's wrong — check for an infinite retry loop in the logs.

## Scope and design notes

- **Single user.** Personal use only; no public submission to Apple Podcasts directory.
- **State = filesystem + git.** No database. `docs/episodes/*.json` sidecars hold per-episode metadata for feed regeneration.
- **Failure mode: skip the day.** A missing episode is fine. A broken `feed.xml` would unsubscribe the user, so we never commit if any phase fails.
- **iTunes namespace** is patched into the `feed` library's RSS output via deterministic string injection in `src/publish.ts`. Not pretty, but contained, and `feed` doesn't natively emit iTunes tags.

## v2 ideas (not in scope)

- Cloudflare R2 + custom domain + signed URLs (real privacy)
- Show-notes generation in `<description>`
- Source-quality scoring dashboard
- ElevenLabs TTS swap
- Slack/Discord webhook on workflow failure
- Topic preferences (more research papers, less fundraising news)

## License

Personal project, all rights reserved. See [LICENSE.md](./LICENSE.md).
