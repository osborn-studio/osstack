import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type KnowledgeFeedbackEntry, type KnowledgePack, type KnowledgePackSummary, type KnowledgeSearchResult } from "@osstack/knowledge";
export interface KnowledgeCloudOptions {
    packs: KnowledgePack[];
    privatePacks?: KnowledgePack[];
    privateAuthToken?: string;
    privateTenantTokens?: Record<string, string>;
    publishedPackDir?: string;
    feedbackLog?: KnowledgeFeedbackEntry[];
    auditLog?: KnowledgeCloudAuditEntry[];
    now?: () => string;
    feedbackSink?: (entry: KnowledgeFeedbackEntry) => void | Promise<void>;
    auditSink?: (entry: KnowledgeCloudAuditEntry) => void | Promise<void>;
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
export interface KnowledgeCloudAuditEntry {
    event_id: string;
    action: "publish" | "private_packs" | "search" | "feedback";
    status: "ok" | "rejected" | "unauthorized";
    created_at: string;
    tenant_id?: string;
    private?: boolean;
    pack_id?: string;
    chunk_id?: string;
    rating?: "useful" | "bad";
    authorized?: boolean;
    result_count?: number;
    issue_codes?: string[];
}
export interface PublishedKnowledgeCloudPacks {
    packs: KnowledgePack[];
    privatePacks: KnowledgePack[];
}
export declare function createKnowledgeCloudHandler(options: KnowledgeCloudOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
export declare function startKnowledgeCloudServer(options: KnowledgeCloudServerOptions): Promise<KnowledgeCloudServerHandle>;
export declare function loadKnowledgeCloudPacksFromIndex(indexPath: string): Promise<KnowledgePack[]>;
export declare function loadPublishedKnowledgeCloudPacksFromDir(root: string): Promise<PublishedKnowledgeCloudPacks>;
//# sourceMappingURL=server.d.ts.map