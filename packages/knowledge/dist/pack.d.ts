import type { KnowledgeMode, KnowledgeFeedbackEntry, KnowledgePack, KnowledgePackIndex, KnowledgePackManifest, KnowledgePin, KnowledgeRetrievalEvalCase, KnowledgeRetrievalEvalSummary, KnowledgeScope, KnowledgeSearchEvidence, KnowledgeSearchResult, KnowledgeSyncEvidence } from "./types.js";
export declare function loadKnowledgePack(path: string): Promise<KnowledgePack>;
export declare function validateKnowledgePackManifest(value: unknown): KnowledgePackManifest;
export declare function loadKnowledgePackIndex(path: string): Promise<KnowledgePackIndex>;
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
export declare function cacheKnowledgeFeedback(options: {
    cacheDir: string;
    chunkId: string;
    rating: "useful" | "bad";
    cloudUrl?: string;
    authToken?: string;
    fetchImpl?: typeof fetch;
    createdAt?: string;
}): Promise<KnowledgeFeedbackEntry>;
export declare function searchKnowledgePacks(packs: KnowledgePack[], query: string, options?: {
    limit?: number;
}): KnowledgeSearchResult[];
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
    fetchImpl?: typeof fetch;
}): Promise<KnowledgeSearchEvidence>;
//# sourceMappingURL=pack.d.ts.map