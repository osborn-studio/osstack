export type KnowledgeSourceKind = "osstack_native" | "processed_mit" | "curated_external" | "internal";

export type KnowledgeMode = "off" | "local" | "cloud";

export type KnowledgeScope = "official" | "team" | "project";

export interface KnowledgeChunk {
  chunk_id: string;
  title: string;
  body: string;
  tags?: string[];
  source_refs?: string[];
}

export interface KnowledgePackManifest {
  id: string;
  version: string;
  name: string;
  license: string;
  source_kind: KnowledgeSourceKind;
  quality_score: number;
  scope?: KnowledgeScope;
  taxonomy?: string[];
  generated_at?: string;
  last_reviewed_at?: string;
  source_attribution?: string[];
  source_provenance?: KnowledgeSourceProvenance[];
  chunks: KnowledgeChunk[];
}

export interface KnowledgeSourceProvenance {
  source_id: string;
  path: string;
  sha256: string;
  license: string;
  scope: KnowledgeScope;
  imported_at: string;
}

export interface KnowledgePack {
  manifest: KnowledgePackManifest;
  path: string;
}

export interface KnowledgeSearchResult {
  pack_id: string;
  pack_version: string;
  chunk_id: string;
  title: string;
  score: number;
  snippet: string;
  tags: string[];
  source_refs: string[];
}

export interface KnowledgePackSummary {
  id: string;
  version: string;
  license: string;
  source_kind: KnowledgeSourceKind;
  quality_score: number;
}

export type KnowledgeSearchEvidence =
  | {
    mode: "off";
    status: "not_used";
    packs: [];
    results: [];
    query?: string;
    reason?: string;
    fallback_mode?: "off";
  }
  | {
    mode: "local" | "cloud";
    status: "recorded";
    query: string;
    packs: KnowledgePackSummary[];
    results: KnowledgeSearchResult[];
    reason?: string;
    fallback_mode?: "local";
  }
  | {
    mode: "local" | "cloud";
    status: "error";
    query?: string;
    reason: string;
    packs: KnowledgePackSummary[];
    results: [];
    fallback_mode?: "local" | "off";
  };
