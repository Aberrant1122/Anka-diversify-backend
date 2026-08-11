import { ChatRequest, AgentResponse, AgentProgressEvent } from "../shared/types";
import { AgentPipeline } from "../orchestration/AgentPipeline";

export class CodingAgent {
  static async runCodingAgent(
    userId: string,
    projectId: string,
    request: ChatRequest,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentResponse> {
    return AgentPipeline.runCodingAgent(userId, projectId, request, onProgress);
  }
}
