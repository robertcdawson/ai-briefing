# Daily AI News Podcast — Tech Specs

## Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (Node 20+) | Aligns with existing Next.js work; rich npm ecosystem; clean RSS/feed/Octokit libs |
| Scheduler | GitHub Actions cron | Free, zero new infra, already proven in prior pipeline |
| News source | Curated RSS feeds via `rss-parser` | Free, deterministic, no API key, no rate limits, easy to extend |
| LLM | OpenRouter → Claude Sonnet (`anthropic/claude-sonnet-4-7`) | Already in workflow; structured output; high reasoning quality |
| TTS | OpenAI `gpt-4o-mini-tts` (direct API) | Supports delivery instructions for a more engaged podcast read; direct OpenAI keeps audio generation reliable |
| Audio | ffmpeg | Industry standard; loudness normalize, concat, encode, ID3 chapters |
| Storage + hosting | Public GitHub repo + GitHub Pages | Free; zero new infra; obscure path = soft privacy |
| RSS feed | `feed` npm package, `feed.xml` committed to repo | Standards-compliant; Apple Podcasts compatible |
| iPhone | Apple Podcasts → "Follow a Show by URL" | Native UX: lock screen, CarPlay, queue, speed control |

### Alternatives considered (and why not for v1)

- **Exa / NewsAPI** instead of RSS: adds cost and complexity without meaningful upside for personal use. Curated RSS gives 90% of the value at 0% of the price.
- **ElevenLabs** instead of OpenAI TTS: better voice but ~$22+/mo vs ~$3/mo. Quality gap doesn't justify cost for v1. Easy swap later.
- **Cloudflare R2 + custom domain** instead of GH Pages: better for true privacy, but adds infra. Recommended for v2.
- **Python** instead of TypeScript: equally fine. Choice is preference-driven.
- **OpenRouter for TTS**: their audio support is newer and less reliable than direct OpenAI. Revisit later.

## Architecture

```
┌─────────────────┐
│ GH Actions cron │   ~06:30 PT daily (13:30 UTC PDT / 14:30 UTC PST)
└────────┬────────┘
         ↓
┌─────────────────┐
│  fetch.ts       │   Pull RSS feeds, filter last 24h → Article[]
└────────┬────────┘
         ↓
┌─────────────────┐
│  curate.ts      │   OpenRouter→Claude: cluster, rank, top 3 → StoryCluster[]
└────────┬────────┘
         ↓
┌─────────────────┐
│  script.ts      │   OpenRouter→Claude: full spoken script → Episode
└────────┬────────┘
         ↓
┌─────────────────┐
│  tts.ts         │   OpenAI TTS: per-segment MP3 chunks
└────────┬────────┘
         ↓
┌─────────────────┐
│  audio.ts       │   ffmpeg: stingers + concat, loudnorm, encode MP3 192k, ID3 tags + chapters
└────────┬────────┘
         ↓
┌─────────────────┐
│  publish.ts     │   Move MP3 to docs/episodes/, regenerate docs/feed.xml
└────────┬────────┘
         ↓
┌─────────────────┐
│  git push       │   GH Pages auto-deploys
└────────┬────────┘
         ↓
┌─────────────────┐
│  Apple Podcasts │   Polls feed; downloads new episode
└─────────────────┘
```

## Repository structure

```
ai-briefing/
├── .github/
│   └── workflows/
│       └── daily.yml              # cron + run pipeline + commit
├── src/
│   ├── index.ts                   # orchestrator
│   ├── fetch.ts                   # RSS aggregation
│   ├── curate.ts                  # cluster + rank + select 3
│   ├── script.ts                  # generate spoken script
│   ├── tts.ts                     # text → audio chunks
│   ├── audio.ts                   # ffmpeg concat/encode
│   ├── publish.ts                 # update feed + move episode
│   ├── feeds.ts                   # curated source list
│   └── types.ts                   # shared interfaces
├── docs/                          # GitHub Pages root
│   ├── feed.xml                   # podcast RSS
│   ├── index.html                 # tiny landing (optional)
│   └── episodes/
│       └── 2026-05-04.mp3
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## Curated source list (starter)

```ts
export const SOURCES = [
  { name: "OpenAI Blog",        url: "https://openai.com/blog/rss.xml" },
  { name: "Anthropic News",     url: "https://www.anthropic.com/news/rss.xml" },
  { name: "Google DeepMind",    url: "https://deepmind.google/blog/rss.xml" },
  { name: "Hugging Face",       url: "https://huggingface.co/blog/feed.xml" },
  { name: "The Verge AI",       url: "https://www.theverge.com/ai-artificial-intelligence/rss/index.xml" },
  { name: "Ars Technica AI",    url: "https://arstechnica.com/ai/feed/" },
  { name: "MIT Tech Review AI", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed/" },
  { name: "Stratechery",        url: "https://stratechery.com/feed/" },
  { name: "Simon Willison",     url: "https://simonwillison.net/atom/everything/" },
];
```

Verify URLs at first build — some publishers move feed paths. Add a smoke test that fetches each at startup and warns on 404s.

## Data structures

```ts
interface Article {
  title: string;
  source: string;
  url: string;
  publishedAt: string;     // ISO 8601
  excerpt: string;         // <description> or first 500 chars
}

interface StoryCluster {
  canonicalKey: string;    // e.g., "openai-releases-tts-3"
  category: "research" | "product-tools" | "business" | "policy-regulation" | "open-source" | "culture";
  headline: string;
  whyItMatters: string;
  caveat: string;
  sources: { url: string; publisher: string }[];
}

interface Episode {
  date: string;            // YYYY-MM-DD
  title: string;           // "AI Briefing — May 4, 2026"
  intro: string;
  segments: {
    title: string;
    script: string;
    sourceUrls: string[];
  }[];
  outro: string;
  audioPath: string;       // docs/episodes/YYYY-MM-DD.mp3
  byteLength: number;
  durationSeconds: number;
}
```

## RSS item shape

```xml
<item>
  <title>AI Briefing — May 4, 2026</title>
  <description><![CDATA[Top 3 AI stories...]]></description>
  <pubDate>Mon, 04 May 2026 13:30:00 GMT</pubDate>
  <guid isPermaLink="false">ai-briefing-2026-05-04</guid>
  <enclosure
    url="https://USER.github.io/ai-briefing/episodes/2026-05-04.mp3"
    length="3450821"
    type="audio/mpeg" />
  <itunes:duration>312</itunes:duration>
  <itunes:explicit>false</itunes:explicit>
</item>
```

Use the `feed` npm package — do not hand-roll XML. `length` must be the actual byte count of the MP3. `guid` must never change once published.

## Environment variables

| Var | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | LLM access (curate + script) |
| `OPENAI_API_KEY` | TTS access |
| `FEED_BASE_URL` | e.g., `https://USER.github.io/ai-briefing` |
| `TTS_MODEL` | OpenAI speech model; default `gpt-4o-mini-tts` supports delivery instructions |
| `TTS_VOICE` | OpenAI TTS voice; default `onyx` |
| `TTS_TIMEOUT_MS` | Per-segment OpenAI speech timeout; default `180000` |
| `AUDIO_CUES_ENABLED` | Toggle synthetic intro/transition/outro stingers (`true`/`false`) |
| `AUDIO_CUE_STYLE` | Generated cue style: `tone`, `chime`, or `tick` |
| `GITHUB_TOKEN` | Provided by Actions; used to commit + push |

Store API keys as GitHub Actions secrets.

## Error handling

| Failure | Behavior |
|---|---|
| RSS source down | Skip that source; continue with others |
| Fewer than 3 viable stories | Produce shorter episode (1-2 stories) |
| LLM call fails | Retry 3x with exponential backoff; on final fail, skip day + notify |
| TTS fails | Retry 3x; on final fail, skip day |
| Audio encode fails | Skip day; preserve script artifact for manual recovery |
| Feed regen fails | Roll back; do not commit broken feed.xml |

Rule of thumb: a missing episode is fine; a broken feed unsubscribes me.

## Cost estimate (monthly)

| Item | Cost |
|---|---|
| GitHub Actions | $0 (well within free tier) |
| GitHub Pages | $0 |
| OpenRouter (curate + script) | ~$2-3 |
| OpenAI TTS | Model-dependent; monitor the OpenAI usage dashboard |
| **Total** | **~$5-8/month** |

## Privacy note

GitHub Pages on a public repo means the audio files and feed are technically reachable by anyone who guesses the URL. Acceptable for AI news content. For real privacy:

- Move to Cloudflare R2 with custom domain
- Add HMAC-signed enclosure URLs with a token rotation policy
- Or: paid GH Pages plan + private repo (still some friction)

This is the v2 upgrade, not an MVP requirement.
