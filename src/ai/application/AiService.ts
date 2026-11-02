import { PrismaClient } from "@prisma/client";
import { assertOwner } from "../../security/project-access";
import { CodingAgent } from "./CodingAgent";
import { ProjectChatService } from "./ProjectChatService";
import { RepositoryContextBuilder } from "../repository/RepositoryContextBuilder";
import { MemoryPersistence } from "../memory/MemoryPersistence";
import { PullRequestReviewer } from "../github/PullRequestReviewer";
import { PullRequestDescription } from "../github/PullRequestDescription";
import {
  ChatRequest,
  ChatResponse,
  AgentProgressEvent,
  AgentResponse,
  ProjectHealth,
  PRReview,
} from "../shared/types";
import { ProjectSidebarService } from "../../services/project-sidebar.service";

const authorizationDb = new PrismaClient();
export class AiService {
  private static instance: AiService;
  private projectChatService: ProjectChatService;

  private constructor() {
    this.projectChatService = new ProjectChatService();
  }

  static getInstance(): AiService {
    if (!AiService.instance) {
      AiService.instance = new AiService();
    }
    return AiService.instance;
  }

  async processGeneralChat(
    userId: string,
    request: ChatRequest,
  ): Promise<ChatResponse> {
    return this.projectChatService.processGeneralChat(userId, request);
  }

  async processProjectChat(
    userId: string,
    projectId: string,
    request: ChatRequest,
  ): Promise<ChatResponse> {
    return this.projectChatService.processProjectChat(
      userId,
      projectId,
      request,
    );
  }

  async runCodingAgent(
    userId: string,
    projectId: string,
    request: ChatRequest,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentResponse> {
    return CodingAgent.runCodingAgent(userId, projectId, request, onProgress);
  }

  async getProjectHealth(
    projectId: string,
    actorId: string,
  ): Promise<ProjectHealth> {
    await assertOwner(authorizationDb, projectId, actorId);
    return ProjectSidebarService.getProjectHealth(projectId);
  }

  async suggestSprintTasks(
    projectId: string,
    sprintId: string,
    capacity: number | undefined,
    actorId: string,
  ) {
    return this.projectChatService.suggestSprintTasks(
      projectId,
      sprintId,
      capacity ?? 10,
      actorId,
    );
  }

  async generateSprint(projectId: string, userPrompt: string, actorId: string) {
    return this.projectChatService.generateSprint(
      projectId,
      userPrompt,
      actorId,
    );
  }

  async suggestTaskOrder(
    projectId: string,
    actorId: string,
    tasks: { id: string; title: string; description?: string }[],
  ) {
    return this.projectChatService.suggestTaskOrder(projectId, actorId, tasks);
  }

  async generatePhaseProposal(
    projectId: string,
    phase: string,
    actorId: string,
    revision?: { previousContent: string; feedback: string },
    brief?: string,
  ) {
    return this.projectChatService.generatePhaseProposal(
      projectId,
      phase,
      actorId,
      revision,
      brief,
    );
  }

  async reviewPullRequest(
    projectId: string,
    prNumber: number,
    actorId: string,
  ): Promise<PRReview> {
    await assertOwner(authorizationDb, projectId, actorId);
    return PullRequestReviewer.reviewPullRequest(projectId, prNumber);
  }

  async generatePRDescription(
    projectId: string,
    prNumber: number,
    actorId: string,
  ) {
    await assertOwner(authorizationDb, projectId, actorId);
    return PullRequestDescription.generatePRDescription(projectId, prNumber);
  }

  async getSessions(
    userId: string,
    type: "general" | "project",
    projectId?: string,
  ) {
    if (!userId) throw new Error("Authentication required");
    if (type === "project")
      await assertOwner(authorizationDb, projectId!, userId);
    return MemoryPersistence.getSessions(userId, type, projectId);
  }

  async getSessionMessages(
    sessionId: string,
    userId: string,
    scope: { type: "general" } | { type: "project"; projectId: string },
  ) {
    return MemoryPersistence.getSessionMessages(sessionId, userId, scope);
  }

  async getProjectContext(projectId: string, userId: string) {
    await assertOwner(authorizationDb, projectId, userId);
    return RepositoryContextBuilder.buildProjectContext(projectId);
  }
}
