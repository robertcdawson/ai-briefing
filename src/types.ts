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
  /** 0-100 audience-impact score from curation; drives narration depth/ordering. */
  importance?: number;
  sources: { url: string; publisher: string }[];
  /** Present when this story is a follow-up to a previously covered story. */
  followUp?: {
    priorDate: string;
    priorFraming: string;
    /** The host's prior on-air stance for this story, copied from the ledger's "take:" so the writer can revisit it. */
    priorStance?: string;
  };
  /** 3-6 verbatim concrete details (figures, named people/orgs, a short quote) pulled from the source articles for the writer to build sentences from. */
  specifics?: string[];
}

/** Minimal record of a story that aired in an episode, stored in the sidecar for future threading. */
export interface CurationRecord {
  canonicalKey: string;
  headline: string;
  whyItMatters: string;
  caveat: string;
  importance?: number;
  category: StoryCategory;
  /** The host's committed on-air judgment or prediction for this story, if any (additive-optional; absent on older sidecars). */
  stance?: string;
  /** Concrete details extracted from the source articles for this story, if any (additive-optional; absent on older sidecars). */
  specifics?: string[];
}

/** Why a scored cluster did not make the episode. */
export type CurationDropReason = "below_threshold" | "over_cap";

/** A single cluster the curator scored, with whether it aired and (if not) why. */
export interface ScoredCluster {
  canonicalKey: string;
  category: StoryCategory;
  headline: string;
  importance: number;
  selected: boolean;
  dropReason?: CurationDropReason;
}

/**
 * Full audit of one curation pass — every scored cluster (selected and dropped)
 * plus summary counts and the thresholds in effect. Observability only; does not
 * affect which stories air.
 */
export interface CurationReport {
  threshold: number;
  maxStories: number;
  total: number;
  selectedCount: number;
  droppedCount: number;
  clusters: ScoredCluster[];
}

/** One read-aloud chunk of the single narrator's monologue. */
export type NarrationChunk = string;

export interface EpisodeSegment {
  title: string;
  chunks: NarrationChunk[];
  sourceUrls: string[];
  /** The host's committed on-air judgment or prediction for this story, if any. Persisted to the sidecar for future stance-threading. */
  stance?: string;
  /** Spoken-delivery hint for this segment, if any. Transient: script-to-tts only, never persisted to the sidecar. */
  delivery?: string;
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
  intro: NarrationChunk[];
  segments: EpisodeSegment[];
  outro: NarrationChunk[];
  audioPath: string;
  byteLength: number;
  durationSeconds: number;
}
