import { exec } from "child_process";
import { promisify } from "util";
import { RepositoryCacheManager } from "./repository-cache.manager";

const execAsync = promisify(exec);

export type RequiredRuntimeTool = "git" | "node" | "npm";

export class RuntimePreflightService {
  private static verifiedTools = new Set<string>();

  /**
   * Verifies that a required runtime tool (git, node, npm) is installed and accessible on PATH.
   * Throws Error("RUNTIME_DEPENDENCY_MISSING: <tool>") if missing.
   */
  public static async verifyTool(tool: RequiredRuntimeTool): Promise<void> {
    if (this.verifiedTools.has(tool)) {
      return;
    }
    try {
      const command = `${tool} --version`;
      await execAsync(command, { timeout: 10000 });
      this.verifiedTools.add(tool);
    } catch (err: any) {
      this.verifiedTools.delete(tool);
      const cleanMsg = RepositoryCacheManager.redactCredentials(err?.message || "");
      throw new Error(`RUNTIME_DEPENDENCY_MISSING: ${tool}`);
    }
  }

  /**
   * Verifies all required runtime tools in list.
   */
  public static async verifyTools(tools: RequiredRuntimeTool[] = ["git", "node", "npm"]): Promise<void> {
    for (const tool of tools) {
      await this.verifyTool(tool);
    }
  }

  /**
   * Returns whether a tool was previously verified in process.
   */
  public static isToolVerified(tool: RequiredRuntimeTool): boolean {
    return this.verifiedTools.has(tool);
  }

  /**
   * Resets verified cache (useful for testing).
   */
  public static resetCache(): void {
    this.verifiedTools.clear();
  }
}
