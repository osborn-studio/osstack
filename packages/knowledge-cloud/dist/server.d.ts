import type { IncomingMessage, ServerResponse } from "node:http";
import { type KnowledgeFeedbackEntry, type KnowledgePack, type KnowledgePackSummary, type KnowledgeSearchResult } from "@osstack/knowledge";
export interface KnowledgeCloudOptions {
    packs: KnowledgePack[];
    privatePacks?: KnowledgePack[];
    now?: () => string;
    feedbackSink?: (entry: KnowledgeFeedbackEntry) => void | Promise<void>;
}
export interface KnowledgeCloudSearchResponse {
    packs: KnowledgePackSummary[];
    results: KnowledgeSearchResult[];
}
export declare function createKnowledgeCloudHandler(options: KnowledgeCloudOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
export declare function loadKnowledgeCloudPacksFromIndex(indexPath: string): Promise<KnowledgePack[]>;
//# sourceMappingURL=server.d.ts.map