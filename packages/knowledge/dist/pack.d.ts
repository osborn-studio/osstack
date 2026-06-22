import type { KnowledgePack, KnowledgePackManifest, KnowledgeSearchResult } from "./types.js";
export declare function loadKnowledgePack(path: string): Promise<KnowledgePack>;
export declare function validateKnowledgePackManifest(value: unknown): KnowledgePackManifest;
export declare function searchKnowledgePacks(packs: KnowledgePack[], query: string, options?: {
    limit?: number;
}): KnowledgeSearchResult[];
export declare function assembleKnowledgeSnippet(results: KnowledgeSearchResult[]): string;
//# sourceMappingURL=pack.d.ts.map