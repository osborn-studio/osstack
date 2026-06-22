import type { KnowledgeMode, KnowledgePack, KnowledgePackManifest, KnowledgeSearchEvidence, KnowledgeSearchResult } from "./types.js";
export declare function loadKnowledgePack(path: string): Promise<KnowledgePack>;
export declare function validateKnowledgePackManifest(value: unknown): KnowledgePackManifest;
export declare function searchKnowledgePacks(packs: KnowledgePack[], query: string, options?: {
    limit?: number;
}): KnowledgeSearchResult[];
export declare function assembleKnowledgeSnippet(results: KnowledgeSearchResult[]): string;
export declare function resolveKnowledgeSearch(options: {
    mode?: KnowledgeMode;
    query?: string;
    packs?: KnowledgePack[];
    limit?: number;
    cloudUrl?: string;
    fetchImpl?: typeof fetch;
}): Promise<KnowledgeSearchEvidence>;
//# sourceMappingURL=pack.d.ts.map