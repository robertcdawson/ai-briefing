import { SPEAKER_PROFILES } from "./speakerProfiles.js";
import type { EpisodeSpeaker, SpeakerId, SpeakerTurn } from "./types.js";

export const EPISODE_SPEAKERS: readonly EpisodeSpeaker[] = (
  Object.values(SPEAKER_PROFILES) as SpeakerProfileValues[]
).map((profile) => ({
  id: profile.id,
  name: profile.name,
  role: profile.role,
  persona: profile.persona,
}));

type SpeakerProfileValues = (typeof SPEAKER_PROFILES)[SpeakerId];

export function getEpisodeSpeakers(): EpisodeSpeaker[] {
  return EPISODE_SPEAKERS.map((speaker) => ({ ...speaker }));
}

export function getSpeaker(id: SpeakerId): EpisodeSpeaker {
  const speaker = EPISODE_SPEAKERS.find((candidate) => candidate.id === id);
  if (!speaker) throw new Error(`Unknown speaker: ${id}`);
  return speaker;
}

export function isSpeakerId(value: unknown): value is SpeakerId {
  return value === "anchor" || value === "analyst";
}

export function formatSpeakerTurns(turns: readonly SpeakerTurn[]): string {
  return turns
    .map((turn) => `${getSpeaker(turn.speaker).name}: ${turn.text}`)
    .join("\n\n");
}

export function speakerNamesForPrompt(): string {
  return EPISODE_SPEAKERS
    .map((speaker) => `- ${speaker.id}: ${speaker.name} — ${speaker.persona}`)
    .join("\n");
}
