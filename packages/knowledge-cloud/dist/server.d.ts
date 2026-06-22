import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type KnowledgeFeedbackEntry, type KnowledgePack, type KnowledgePackSummary, type KnowledgeSearchResult } from "@osstack/knowledge";
export interface KnowledgeCloudOptions {
    packs: KnowledgePack[];
    privatePacks?: KnowledgePack[];
    privateAuthToken?: string;
    privateTenantTokens?: Record<string, string>;
    feedbackLog?: KnowledgeFeedbackEntry[];
    now?: () => string;
    feedbackSink?: (entry: KnowledgeFeedbackEntry) => void | Promise<void>;
}
export interface KnowledgeCloudServerOptions extends KnowledgeCloudOptions {
    host?: string;
    port?: number;
}
export interface KnowledgeCloudServerHandle {
    url: string;
    server: Server;
    close: () => Promise<void>;
}
export interface KnowledgeCloudSearchResponse {
    packs: KnowledgePackSummary[];
    results: KnowledgeSearchResult[];
}
export declare function createKnowledgeCloudHandler(options: KnowledgeCloudOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
export declare function startKnowledgeCloudServer(options: KnowledgeCloudServerOptions): Promise<KnowledgeCloudServerHandle>;
export declare function loadKnowledgeCloudPacksFromIndex(indexPath: string): Promise<KnowledgePack[]>;
//# sourceMappingURL=server.d.ts.map