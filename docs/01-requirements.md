# Daily AI News Podcast — Requirements

## Goal

A 4-7 minute audio briefing on the top AI news of the past 24 hours, automatically delivered to my iPhone every morning, with zero daily intervention.

## Target user

Single user (me). Personal-use only. No public distribution.

## Success criteria

- Episode arrives in Apple Podcasts on iPhone before 8 AM Pacific
- Episode is 4-7 minutes long, sounds like a script (not stitched summaries)
- Content is fresh (last 24h), accurate (sourced from credible publishers), listenable
- Pipeline runs daily without manual intervention for at least 30 days
- Total recurring cost under $10/month

## Functional requirements

### Content

- Pulls from a curated set of AI news RSS sources
- Filters to last 24 hours
- Selects top 3 stories, clustering near-duplicates across sources
- Each segment includes: what happened, why it matters, brief caveat
- Episode has intro hook, three segments with transitions, synthesis outro

### Delivery

- Output is a valid podcast RSS feed (Apple Podcasts compatible: enclosure URL, byte length, MIME type, stable GUID)
- Audio is MP3 (192 kbps, normalized loudness, ID3 tagged)
- Subscribed via "Follow a Show by URL" in Apple Podcasts

### Automation

- Runs daily on a cron schedule (~06:30 Pacific)
- No daily user action required
- Logs JSON status; sends notification on workflow failure

## Non-functional requirements

- **Cost:** Under $10/month recurring
- **Reliability:** Graceful failure (skip the day rather than publish a broken feed)
- **Privacy:** Feed URL not publicly indexed; obscure path acts as soft auth
- **Maintenance:** No code changes required for at least 90 days post-launch

## Out of scope (v1)

- Public Apple Podcasts directory submission
- Multiple voices, dialogue format, music beds, sound effects
- Chapter markers, transcript search
- Web-based admin or preview UI
- Topic personalization beyond "AI news"
- Real auth on the feed URL (HMAC-signed URLs, basic auth, etc.)

## Stretch (v2+)

- Cloudflare R2 + custom domain for proper privacy
- Source-quality scoring + ranking dashboard
- Auto-generated show notes in episode description
- Slack/email digest companion
- Topic preferences (more research papers, less fundraising news)
- Switch to ElevenLabs for higher voice quality
