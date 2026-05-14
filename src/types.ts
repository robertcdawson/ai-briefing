export interface Article {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  excerpt: string;
}

export const STORY_CATEGORY_DEFINITIONS = [
  {
    id: "research",
    label: "Research Breakthrough",
    prompt: "new papers, benchmarks, model capabilities, evaluations, or safety research",
  },
  {
    id: "product-tools",
    label: "Product & Tool Watch",
    prompt: "new AI products, developer tools, APIs, agents, hardware, or deployment features",
  },
  {
    id: "business",
    label: "AI Business Watch",
    prompt: "funding, acquisitions, pricing, partnerships, strategy, revenue, or market shifts",
  },
  {
    id: "policy-regulation",
    label: "Policy & Regulation Watch",
    prompt: "laws, enforcement, standards, copyright, privacy, labor, or public-sector AI action",
  },
  {
    id: "open-source",
    label: "Open Source Watch",
    prompt: "open weights, open datasets, community frameworks, licensing, or reproducibility",
  },
  {
    id: "culture",
    label: "AI Culture Signal",
    prompt: "social impact, media, education, labor, creative use, misuse, or public perception",
  },
] as const;

export type StoryCategory = (typeof STORY_CATEGORY_DEFINITIONS)[number]["id"];

export function getStoryCategoryLabel(category: StoryCategory): string {
  const definition = STORY_CATEGORY_DEFINITIONS.find((candidate) => candidate.id === category);
  if (!definition) throw new Error(`Unknown story category: ${category}`);
  return definition.label;
}

export interface StoryCluster {
  canonicalKey: string;
  category: StoryCategory;
  headline: string;
  whyItMatters: string;
  caveat: string;
  sources: { url: string; publisher: string }[];
}

export type SpeakerId = "anchor" | "analyst";

export interface EpisodeSpeaker {
  id: SpeakerId;
  name: string;
  role: string;
  persona: string;
}

export interface SpeakerTurn {
  speaker: SpeakerId;
  text: string;
}

export interface EpisodeSegment {
  title: string;
  turns: SpeakerTurn[];
  sourceUrls: string[];
}

export type EpisodePartKind = "intro" | "segment" | "outro";

export interface EpisodePartTiming {
  kind: EpisodePartKind;
  title: string;
  startTime: number;
  durationSeconds: number;
  index?: number;
}

export interface Episode {
  date: string;
  title: string;
  speakers: EpisodeSpeaker[];
  intro: SpeakerTurn[];
  segments: EpisodeSegment[];
  outro: SpeakerTurn[];
  audioPath: string;
  byteLength: number;
  durationSeconds: number;
}
