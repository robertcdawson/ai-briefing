# Claude Code Build Prompt — AI News Podcast

> **Setup:** Save `01-requirements.md`, `02-tech-specs.md`, and `03-user-flow.md` into the project root. Then run `claude` in that directory and paste the prompt below.

---

## Prompt to paste

I'm building a daily AI news podcast pipeline. Read `01-requirements.md`, `02-tech-specs.md`, and `03-user-flow.md` in this directory before doing anything else — they define the full spec. Confirm you've read all three, then proceed.

**Build the v1 MVP exactly as specified. No scope creep beyond what's documented.**

### What to build

Implement the repo structure shown in `02-tech-specs.md`:

1. **`package.json`** with dependencies: `rss-parser`, `feed`, `openai` (used for both OpenRouter LLM calls via custom `baseURL` and direct OpenAI TTS), `execa`, `dotenv`, `@types/node`, `typescript`, `tsx`. Type: `"module"`.

2. **`tsconfig.json`** — strict, ESM, Node 20 target, `"moduleResolution": "bundler"`.

3. **`src/feeds.ts`** — the curated `SOURCES` array from tech specs.

4. **`src/types.ts`** — `Article`, `StoryCluster`, `Episode` interfaces from tech specs.

5. **`src/fetch.ts`** — fetch all SOURCES via `rss-parser` in parallel with per-feed timeout (10s) and error tolerance (skip failed feeds, log warning). Filter to articles with `pubDate` within the last 24h. Return `Article[]`.

6. **`src/curate.ts`** — call OpenRouter using the OpenAI SDK with `baseURL: "https://openrouter.ai/api/v1"` and model `anthropic/claude-sonnet-4-7`. Use JSON Schema response format to enforce a top-3 cluster output. Prompt the model to: (a) cluster near-duplicates by canonical story, (b) scan the recurring editorial categories, (c) score audience impact for researchers/builders/technical leaders, and (d) return exactly 3 (or fewer if fewer credible stories exist) `StoryCluster`s. Pass article excerpts only — no full text fetching in v1.

7. **`src/script.ts`** — second OpenRouter call with same model. Prompt for a podcast script: 15-25s engaging summary hook, three recurring labeled segments of ~90s each (what happened → why it matters → brief explainer if needed → caveat), short transitions, and a 30-40s synthesis outro identifying any pattern across the three stories. Output JSON matching the `Episode` interface (without `audioPath`, `byteLength`, `durationSeconds` — those get filled in later). Target ~600-1000 words total.

8. **`src/tts.ts`** — direct OpenAI calls (`openai` SDK, no custom baseURL): `audio.speech.create` with `model: "gpt-4o-mini-tts"`, `voice: "onyx"` (both configurable via env), enthusiastic-but-precise delivery instructions, and `response_format: "mp3"`. Generate one MP3 per script segment (intro, each story segment, outro) into a temp directory. Run sequentially or with limited concurrency.

9. **`src/audio.ts`** — invoke ffmpeg via `execa`. Steps: (a) concat all segment MP3s using ffmpeg's concat demuxer, (b) apply `loudnorm` filter (EBU R128 target -16 LUFS), (c) re-encode to MP3 192kbps, (d) write ID3v2 tags (title, artist="AI Briefing", album, year, comment with episode date). Ensure ffmpeg is invoked correctly in the GH Actions environment (apt install in workflow).

10. **`src/publish.ts`** — move final MP3 to `docs/episodes/YYYY-MM-DD.mp3`. Regenerate `docs/feed.xml` from scratch using the `feed` package: walk `docs/episodes/`, build feed items in reverse chronological order, retain at most the last 30 episodes in the feed (older MP3s remain on disk but are not listed). Set required iTunes namespace fields (title, author, summary, explicit=false, image optional placeholder). Compute `enclosure.length` from actual MP3 byte size.

11. **`src/index.ts`** — orchestrate: fetch → curate → script → tts → audio → publish. Wrap each phase in try/catch. Emit one JSON log line per phase with timing and counts. On any failure, exit non-zero and do not commit.

12. **`.github/workflows/daily.yml`** — cron `30 13 * * *` (06:30 PT during PDT; document the PST drift in README). Steps:
    - `actions/checkout@v4`
    - `actions/setup-node@v4` with Node 20
    - `sudo apt-get update && sudo apt-get install -y ffmpeg`
    - `npm ci`
    - `npx tsx src/index.ts` with secrets injected as env
    - If `docs/` changed: `git add docs/ && git -c user.email=actions@github.com -c user.name=actions commit -m "Episode YYYY-MM-DD" && git push`

13. **`README.md`** — setup instructions (clone, install, env vars, GH Actions secrets), how to manually trigger via `workflow_dispatch`, how to subscribe in Apple Podcasts (paste from `03-user-flow.md`), troubleshooting (broken feed, missing episode, validating with castfeedvalidator).

14. **`.env.example`** with `OPENROUTER_API_KEY=`, `OPENAI_API_KEY=`, `FEED_BASE_URL=https://USER.github.io/ai-briefing`, `TTS_VOICE=onyx`.

### Code quality requirements

- TypeScript strict mode; no `any` without a comment justifying it
- All external calls (RSS, OpenRouter, OpenAI, ffmpeg) wrapped with retry (3x) and timeout
- All file I/O async (`node:fs/promises`)
- Structured logging: one JSON object per significant step (`{phase, status, durationMs, ...}`)
- Pure functions where possible; side effects isolated in `index.ts`
- Add a single smoke test (`npm test`) that runs `fetch.ts` against the live SOURCES and asserts at least one article returns

### Out of scope (do not build)

- Music, sound effects, multi-voice
- Web admin or preview UI
- Database (filesystem + git is the state)
- Tests beyond the fetch smoke test
- Custom domain / R2 / signed URLs
- Show notes generation beyond the basic episode description

### Acceptance criteria

- `npx tsx src/index.ts` succeeds locally with both API keys set
- `docs/feed.xml` validates at castfeedvalidator.com
- `docs/episodes/YYYY-MM-DD.mp3` plays in any MP3 player and shows correct ID3 tags
- GH Actions `workflow_dispatch` run completes green and produces a commit
- README explains end-to-end setup including the iPhone subscription step

### Build order

1. Skeleton: `package.json`, `tsconfig.json`, `src/types.ts`, `src/feeds.ts`
2. `src/fetch.ts` + smoke test against live feeds
3. `src/curate.ts` + manual run with logged output
4. `src/script.ts` + manual run; review the script aloud before TTS
5. `src/tts.ts` + `src/audio.ts` end-to-end on the script from step 4
6. `src/publish.ts` + verify `feed.xml` validates
7. `src/index.ts` orchestration
8. `.github/workflows/daily.yml` + test via `workflow_dispatch`
9. `README.md`

After each step, show me what was built before moving to the next. Stop and ask if anything is ambiguous.
