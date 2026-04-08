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
            priority: string;
            description: string | null;
            id: string;
            githubUrl: string | null;
            name: string;
            phase: string | null;
            progress: number;
            teamSize: number;
            status: string;
            startDate: Date;
            dueDate: Date | null;
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
        projectId: string | null;
        userId: string;
        createdAt: Date;
        updatedAt: Date;
        type: string;
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
        projectId: string | null;
        userId: string;
        createdAt: Date;
        updatedAt: Date;
        type: string;
        title: string | null;
    }>;
    getProjectContext(projectId: string, userId: string): Promise<ProjectContext>;
}
//# sourceMappingURL=ai-service.d.ts.map