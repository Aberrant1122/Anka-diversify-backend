import { CodingAgent } from "./CodingAgent";
import { ProjectChatService } from "./ProjectChatService";
import { RepositoryContextBuilder } from "../repository/RepositoryContextBuilder";
import { MemoryPersistence } from "../memory/MemoryPersistence";
import { PullRequestReviewer } from "../github/PullRequestReviewer";
import { PullRequestDescription } from "../github/PullRequestDescription";
import { ChatRequest, ChatResponse, AgentProgressEvent, AgentResponse, ProjectHealth, PRReview } from "../shared/types";

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

  async processGeneralChat(userId: string, request: ChatRequest): Promise<ChatResponse> {
    return this.projectChatService.processGeneralChat(userId, request);
  }

  async processProjectChat(userId: string, projectId: string, request: ChatRequest): Promise<ChatResponse> {
    return this.projectChatService.processProjectChat(userId, projectId, request);
  }

  async runCodingAgent(
    userId: string,
    projectId: string,
    request: ChatRequest,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentResponse> {
    return CodingAgent.runCodingAgent(userId, projectId, request, onProgress);
  }

  async getProjectHealth(projectId: string): Promise<ProjectHealth> {
    return this.projectChatService.getProjectHealth(projectId);
  }

  async suggestSprintTasks(projectId: string, sprintId: string, capacity?: number) {
    return this.projectChatService.suggestSprintTasks(projectId, sprintId, capacity);
  }

  async generateSprint(projectId: string, userPrompt: string) {
    return this.projectChatService.generateSprint(projectId, userPrompt);
  }

  async suggestTaskOrder(tasks: { id: string; title: string; description?: string }[]) {
    return this.projectChatService.suggestTaskOrder(tasks);
  }

  async generatePhaseProposal(
    projectId: string,
    phase: string,
    revision?: { previousContent: string; feedback: string },
    brief?: string,
  ) {
    return this.projectChatService.generatePhaseProposal(projectId, phase, revision, brief);
  }

  async reviewPullRequest(projectId: string, prNumber: number): Promise<PRReview> {
    return PullRequestReviewer.reviewPullRequest(projectId, prNumber);
  }

  async generatePRDescription(projectId: string, prNumber: number) {
    return PullRequestDescription.generatePRDescription(projectId, prNumber);
  }

  async getSessions(userId: string, type: "general" | "project", projectId?: string) {
    return MemoryPersistence.getSessions(userId, type, projectId);
  }

  async getSessionMessages(sessionId: string, userId: string) {
    return MemoryPersistence.getSessionMessages(sessionId, userId);
  }

  async getProjectContext(projectId: string, userId: string) {
    return RepositoryContextBuilder.buildProjectContext(projectId);
  }
}
