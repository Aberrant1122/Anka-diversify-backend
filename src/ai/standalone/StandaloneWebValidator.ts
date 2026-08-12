import { AgentFileChange } from "../shared/types";

export class StandaloneWebValidator {
  static validateAssets(changes: AgentFileChange[]): { valid: boolean; missing: string[] } {
    const missing: string[] = [];
    if (!changes.some((c) => c.path.endsWith("index.html") || c.path.endsWith(".html"))) {
      missing.push("index.html");
    }
    if (!changes.some((c) => c.path.endsWith("style.css") || c.path.endsWith(".css"))) {
      missing.push("style.css");
    }
    if (!changes.some((c) => c.path.endsWith("script.js") || c.path.endsWith(".js"))) {
      missing.push("script.js");
    }
    return { valid: missing.length === 0, missing };
  }
}
