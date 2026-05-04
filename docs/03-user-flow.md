# Daily AI News Podcast — User Flow

## Daily flow (zero action required)

```
06:30 PT     GH Actions cron fires
06:30-06:35  Fetch RSS, curate, generate script
06:35-06:38  TTS + audio encode
06:38        Commit episode + updated feed.xml; GH Pages deploys
06:39+       Apple Podcasts polls feed (varies; usually <2hr)
~07-08 AM    New episode lands on iPhone
~08:00       I open Apple Podcasts during coffee/commute and play
```

```mermaid
sequenceDiagram
    autonumber
    participant Cron as GH Actions Cron
    participant Job as Pipeline Script
    participant LLM as OpenRouter<br/>(Claude Sonnet)
    participant TTS as OpenAI TTS
    participant Pages as GitHub Pages
    participant Apple as Apple Podcasts
    participant Me as Me (iPhone)

    Note over Cron: 06:30 PT daily
    Cron->>Job: trigger workflow
    Job->>Job: fetch RSS (last 24h)
    Job->>LLM: cluster + rank candidates
    LLM-->>Job: top 3 StoryClusters
    Job->>LLM: generate spoken script
    LLM-->>Job: Episode (intro, segments, outro)
    Job->>TTS: synthesize per segment
    TTS-->>Job: MP3 chunks
    Job->>Job: ffmpeg concat + loudnorm + ID3
    Job->>Pages: commit episode + feed.xml
    Pages->>Pages: auto-deploy
    Note over Apple: polls feed periodically
    Apple->>Pages: GET feed.xml
    Pages-->>Apple: updated feed
    Apple->>Pages: GET YYYY-MM-DD.mp3
    Pages-->>Apple: episode audio
    Note over Me: morning coffee / commute
    Me->>Apple: open app, tap play
    Apple-->>Me: 4-7 min AI briefing
```

## One-time setup flow

1. Build and deploy the repo (Claude Code session)
2. Trigger the workflow manually via Actions UI to confirm a clean run
3. Confirm `feed.xml` is reachable: `curl https://USER.github.io/ai-briefing/feed.xml`
4. Validate at [castfeedvalidator.com](https://castfeedvalidator.com) — paste the URL, fix any errors before subscribing
5. On iPhone:
   - Open Apple Podcasts
   - Library tab → top-right menu (•••) → **Follow a Show by URL**
   - Paste `https://USER.github.io/ai-briefing/feed.xml`
   - Tap **Follow**
6. Tap the show → settings gear → enable **Auto Download** and **Notify When New Episode**

## Listening flow

- New episode appears in Library overnight
- Tap to play; works on lock screen, CarPlay, AirPods
- Skip 30s, 1.5x speed, queue, mark as played — all native
- Listened state syncs across devices via iCloud

## Failure flow

- GH Actions sends a workflow-failure email to the repo owner by default
- Optional v1.5: add a second job that pings a Slack/Discord webhook on failure
- No episode appears that morning — correct behavior; broken episode is worse than missing one
- Manual recovery: open Actions tab → re-run the failed run after fixing root cause

## What the morning feels like

- Pick up phone → Apple Podcasts already shows "AI Briefing" with a fresh episode dated today
- Tap → 4-7 minutes of context-rich AI news while making coffee or driving
- No tab management, no email triage, no doom-scroll
- Episode auto-marks as played; tomorrow it just happens again
