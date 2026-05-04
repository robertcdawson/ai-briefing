export interface Article {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  excerpt: string;
}

export interface StoryCluster {
  canonicalKey: string;
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
