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

export const STORY_CATEGORY_LABELS = {
  research: "Research Breakthrough",
  "product-tools": "Product & Tool Watch",
  business: "AI Business Watch",
  "policy-regulation": "Policy & Regulation Watch",
  "open-source": "Open Source Watch",
  culture: "AI Culture Signal",
} as const satisfies Record<StoryCategory, string>;

export interface StoryCluster {
  canonicalKey: string;
  category: StoryCategory;
  headline: string;
  whyItMatters: string;
  caveat: string;
  sources: { url: string; publisher: string }[];
}

export interface EpisodeSegment {
  title: string;
  script: string;
  sourceUrls: string[];
}

export interface Episode {
  date: string;
  title: string;
  intro: string;
  segments: EpisodeSegment[];
  outro: string;
  audioPath: string;
  byteLength: number;
  durationSeconds: number;
}
