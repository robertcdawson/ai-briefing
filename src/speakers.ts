import type { EpisodeSpeaker, SpeakerId, SpeakerTurn } from "./types.js";

export const EPISODE_SPEAKERS: readonly EpisodeSpeaker[] = [
  {
    id: "anchor",
    name: "The Anchor",
    role: "Host",
    persona:
      "Concise, skeptical, and fact-forward. Keeps the story order straight, names what is known, and flags weak claims.",
  },
  {
    id: "analyst",
    name: "The Analyst",
    role: "Analyst",
    persona:
      "Warmer and more playful. Asks the practical so-what question and adds memorable analogies without inventing facts.",
  },
];

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
