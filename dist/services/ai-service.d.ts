import { ChatRequest, ChatResponse, ProjectContext } from "../types";
export declare class AiService {
    private static instance;
    private openai;
    private constructor();
    private getOpenAI;
    static getInstance(): AiService;
    processGeneralChat(userId: string, request: ChatRequest): Promise<ChatResponse>;
    processProjectChat(userId: string, projectId: string, request: ChatRequest): Promise<ChatResponse>;
    private buildGeneralContext;
    private buildProjectContext;
    private buildGeneralPrompt;
    private buildProjectPrompt;
    private getOrCreateSession;
    private saveMessage;
    private updateSessionTitle;
    private getMessageCount;
    getSessions(userId: string, type: "general" | "project", projectId?: string): Promise<({
        project: {
            id: string;
            name: string;
            description: string | null;
            phase: string | null;
            progress: number;
            teamSize: number;
            userId: string;
            createdAt: Date;
            updatedAt: Date;
        } | null;
        messages: {
            id: string;
            sessionId: string;
            createdAt: Date;
            role: string;
            content: string;
            metadata: import("@prisma/client/runtime/library").JsonValue | null;
        }[];
    } & {
        id: string;
        userId: string;
        createdAt: Date;
        updatedAt: Date;
        type: string;
        projectId: string | null;
        title: string | null;
    })[]>;
    getSessionMessages(sessionId: string, userId: string): Promise<{
        messages: {
            id: string;
            sessionId: string;
            createdAt: Date;
            role: string;
            content: string;
            metadata: import("@prisma/client/runtime/library").JsonValue | null;
        }[];
    } & {
        id: string;
        userId: string;
        createdAt: Date;
        updatedAt: Date;
        type: string;
        projectId: string | null;
        title: string | null;
    }>;
    getProjectContext(projectId: string, userId: string): Promise<ProjectContext>;
}
//# sourceMappingURL=ai-service.d.ts.map