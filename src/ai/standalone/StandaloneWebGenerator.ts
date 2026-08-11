import { AgentFileChange } from "../shared/types";

export class StandaloneWebGenerator {
  static createDefaultFiles(message: string): AgentFileChange[] {
    // Dynamic generation is driven entirely by LLM repository analysis rather than hardcoded templates.
    return [];
  }
}

