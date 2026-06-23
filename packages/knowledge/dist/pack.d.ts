import type { KnowledgeMode, KnowledgeAdaptationPlan, KnowledgeFeedbackEntry, KnowledgePack, KnowledgeCachePruneResult, KnowledgePackIndex, KnowledgePackManifest, KnowledgePublishCatalog, KnowledgePublishGateReport, KnowledgePin, KnowledgeRetrieveOptions, KnowledgeRetrievalEvalCase, KnowledgeRetrievalEvalSummary, KnowledgeScope, KnowledgeSearchEvidence, KnowledgeSearchResult, KnowledgeSyncEvidence } from "./types.js";
export declare function loadKnowledgePack(path: string): Promise<KnowledgePack>;
export declare function validateKnowledgePackManifest(value: unknown): KnowledgePackManifest;
export declare function validateKnowledgePublishGate(manifest: KnowledgePackManifest, options?: {
    requireOfficial?: boolean;
}): KnowledgePublishGateReport;
export declare function createKnowledgeAdaptationPlan(options: {
    path: string;
    sourceName: string;
    sourceLicense: string;
    generatedAt?: string;
    targetScope?: KnowledgeScope;
    targetSourceKind?: KnowledgeAdaptationPlan["target_source_kind"];
    taxonomyMap?: Record<string, string[]>;
}): Promise<KnowledgeAdaptationPlan>;
export declare function validateKnowledgeAdaptationPlan(plan: KnowledgeAdaptationPlan): KnowledgePublishGateReport;
export declare function loadKnowledgePackIndex(path: string): Promise<KnowledgePackIndex>;
export declare function createKnowledgePublishCatalog(options: {
    indexPath: string;
    evalFixturePath?: string;
    generatedAt?: string;
    topK?: number;
}): Promise<KnowledgePublishCatalog>;
export declare function validateKnowledgePackIndex(value: unknown): KnowledgePackIndex;
export declare function importKnowledgeSource(options: {
    path: string;
    id: string;
    name: string;
    license: string;
    scope: KnowledgeScope;
    version?: string;
    taxonomy?: string[];
    qualityScore?: number;
    generatedAt?: string;
}): Promise<KnowledgePackManifest>;
export declare function ingestKnowledgeSource(options: {
    path: string;
    id: string;
    name: string;
    license: string;
    scope: KnowledgeScope;
    version?: string;
    taxonomy?: string[];
    qualityScore?: number;
    generatedAt?: string;
    sourceKind?: KnowledgePackManifest["source_kind"];
    sourceAttribution?: string[];
    review?: KnowledgePackManifest["review"];
}): Promise<KnowledgePackManifest>;
export declare function syncKnowledgeCache(options: {
    cacheDir: string;
    cloudUrl: string;
    authToken?: string;
    privatePacks?: boolean;
    tenantId?: string;
    fetchImpl?: typeof fetch;
}): Promise<KnowledgeSyncEvidence>;
export declare function listCachedKnowledgePacks(cacheDir: string): Promise<KnowledgePack[]>;
export declare function pinKnowledgePack(cacheDir: string, spec: string): Promise<KnowledgePin>;
export declare function pruneKnowledgeCache(options: {
    cacheDir: string;
    keepVersions?: number;
    apply?: boolean;
}): Promise<KnowledgeCachePruneResult>;
export declare function cacheKnowledgeFeedback(options: {
    cacheDir: string;
    chunkId: string;
    rating: "useful" | "bad";
    cloudUrl?: string;
    authToken?: string;
    tenantId?: string;
    fetchImpl?: typeof fetch;
    createdAt?: string;
}): Promise<KnowledgeFeedbackEntry>;
export declare function searchKnowledgePacks(packs: KnowledgePack[], query: string, options?: {
    limit?: number;
}): KnowledgeSearchResult[];
export declare function retrieveKnowledge(options: KnowledgeRetrieveOptions): Promise<KnowledgeSearchEvidence>;
export declare function evaluateKnowledgeRetrieval(packs: KnowledgePack[], cases: KnowledgeRetrievalEvalCase[], options?: {
    topK?: number;
}): KnowledgeRetrievalEvalSummary;
export declare function assembleKnowledgeSnippet(results: KnowledgeSearchResult[]): string;
export declare function resolveKnowledgeSearch(options: {
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
}): Promise<KnowledgeSearchEvidence>;
//# sourceMappingURL=pack.d.ts.map