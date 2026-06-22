export type KnowledgeSourceKind = "osstack_native" | "processed_mit" | "curated_external" | "internal";
export type KnowledgeMode = "off" | "local" | "cloud";
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
    generated_at?: string;
    source_attribution?: string[];
    chunks: KnowledgeChunk[];
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
//# sourceMappingURL=types.d.ts.map