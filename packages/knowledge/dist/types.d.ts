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
    tenant_id?: string;
    taxonomy?: string[];
    generated_at?: string;
    last_reviewed_at?: string;
    review?: KnowledgeReview;
    source_attribution?: string[];
    source_provenance?: KnowledgeSourceProvenance[];
    chunks: KnowledgeChunk[];
}
export type KnowledgeAdaptationStatus = "planned" | "ready_for_review" | "approved";
export interface KnowledgeAdaptationFamily {
    family_id: string;
    source_paths: string[];
    source_count: number;
    target_pack_id: string;
    target_name: string;
    target_taxonomy: string[];
    source_license: string;
    target_license: string;
    status: KnowledgeAdaptationStatus;
    required_actions: string[];
}
export interface KnowledgeAdaptationPlan {
    generated_at: string;
    source_name: string;
    source_root: string;
    source_license: string;
    target_scope: KnowledgeScope;
    target_source_kind: Extract<KnowledgeSourceKind, "processed_mit" | "curated_external">;
    families: KnowledgeAdaptationFamily[];
}
export interface KnowledgeReview {
    status: "approved" | "changes_requested";
    reviewer_id: string;
    reviewed_at: string;
    summary: string;
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
export interface KnowledgeSyncEvidence {
    status: "synced" | "error";
    packs: KnowledgePackSummary[];
    cache_dir: string;
    skipped_pins?: KnowledgePackSummary[];
    reason?: string;
}
export interface KnowledgePin {
    pack_id: string;
    version: string;
}
export interface KnowledgeCachePruneResult {
    cache_dir: string;
    mode: "dry-run" | "applied";
    keep_versions: number;
    removed: KnowledgePackSummary[];
    kept: KnowledgePackSummary[];
}
export interface KnowledgeFeedbackEntry {
    chunk_id: string;
    rating: "useful" | "bad";
    status: "recorded" | "sent";
    created_at: string;
    tenant_id?: string;
    authorized?: boolean;
    reason?: string;
}
export interface KnowledgeRetrievalEvalCase {
    id: string;
    query: string;
    expected_chunk_id: string;
}
export interface KnowledgeRetrievalEvalResult {
    id: string;
    query: string;
    expected_chunk_id: string;
    matched: boolean;
    rank: number | null;
    top_chunk_ids: string[];
}
export interface KnowledgeRetrievalEvalSummary {
    total: number;
    passed: number;
    failed: number;
    top_k: number;
    results: KnowledgeRetrievalEvalResult[];
}
export interface KnowledgeSearchResult {
    pack_id: string;
    pack_version: string;
    chunk_id: string;
    title: string;
    score: number;
    snippet: string;
    matched_terms: string[];
    tags: string[];
    source_refs: string[];
}
export interface KnowledgeRetrievalMetadata {
    engine: "bm25";
    query_terms: string[];
    searched_packs: number;
    searched_chunks: number;
    fallback?: "local" | "off";
}
export interface KnowledgeRetrieveOptions {
    mode?: KnowledgeMode;
    query?: string;
    packs?: KnowledgePack[];
    limit?: number;
    cloudUrl?: string;
    authToken?: string;
    tenantId?: string;
    staleAfterDays?: number;
    now?: string | Date;
    fetchImpl?: typeof fetch;
}
export interface KnowledgePackSummary {
    id: string;
    version: string;
    license: string;
    source_kind: KnowledgeSourceKind;
    quality_score: number;
}
export interface KnowledgePackIndexEntry {
    id: string;
    version: string;
    path: string;
    scope: KnowledgeScope;
    source_kind: KnowledgeSourceKind;
    quality_score: number;
    taxonomy?: string[];
}
export interface KnowledgePackIndex {
    generated_at: string;
    channel: "official";
    packs: KnowledgePackIndexEntry[];
}
export interface KnowledgePublishGateIssue {
    code: string;
    message: string;
}
export interface KnowledgePublishGateReport {
    ok: boolean;
    issues: KnowledgePublishGateIssue[];
}
export type KnowledgeSearchEvidence = {
    mode: "off";
    status: "not_used";
    packs: [];
    results: [];
    query?: string;
    reason?: string;
    fallback_mode?: "off";
    retrieval?: KnowledgeRetrievalMetadata;
} | {
    mode: "local" | "cloud";
    status: "recorded";
    query: string;
    packs: KnowledgePackSummary[];
    results: KnowledgeSearchResult[];
    reason?: string;
    fallback_mode?: "local";
    cache_stale?: boolean;
    cache_age_days?: number;
    cache_stale_after_days?: number;
    retrieval?: KnowledgeRetrievalMetadata;
} | {
    mode: "local" | "cloud";
    status: "error";
    query?: string;
    reason: string;
    packs: KnowledgePackSummary[];
    results: [];
    fallback_mode?: "local" | "off";
    retrieval?: KnowledgeRetrievalMetadata;
};
//# sourceMappingURL=types.d.ts.map