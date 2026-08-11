import { AgentFileChange, ExecutionContract } from "../shared/types";

export class ContractGuardrails {
  static runDiffContractCritic(
    proposedChanges: AgentFileChange[],
    contract: ExecutionContract,
  ): {
    accepted: AgentFileChange[];
    rejected: Array<{ path: string; reason: string }>;
    log: string;
  } {
    const broadScopeTypes = new Set(["NEW_FEATURE", "REFACTOR", "OPTIMIZATION"]);
    const isBroadScope = broadScopeTypes.has(contract.taskType);

    const accepted: AgentFileChange[] = [];
    const rejected: Array<{ path: string; reason: string }> = [];

    for (const change of proposedChanges) {
      const normPath = (change.path || "").replace(/\\/g, "/");

      if (!isBroadScope && contract.contextScope.length > 0) {
        const inScope = contract.contextScope.some(
          (s) => normPath.startsWith(s) || normPath.includes(`/${s}/`) || normPath === s,
        );
        if (!inScope) {
          rejected.push({
            path: change.path,
            reason: `Out of contract scope. Contract allows: [${contract.contextScope.join(", ")}]. Got: "${normPath}". Forbidden by Diff Critic.`,
          });
          continue;
        }
      }

      let forbiddenViolation: string | null = null;

      if (contract.forbiddenActions.includes("create_new_pages") && /page\.(tsx|ts|jsx|js)$/i.test(normPath)) {
        forbiddenViolation = `"create_new_pages" is forbidden by contract`;
      } else if (contract.forbiddenActions.includes("add_routes") && /router\.|routes\.|routing\./i.test(normPath)) {
        forbiddenViolation = `"add_routes" is forbidden by contract`;
      } else if (
        contract.forbiddenActions.includes("create_utilities") &&
        /util(s|ity)?\/|helper(s)?\//.test(normPath) &&
        !contract.targetPaths.some((tp) => normPath.startsWith(tp))
      ) {
        forbiddenViolation = `"create_utilities" is forbidden by contract`;
      } else if (
        (contract.taskType === "DELETE_FOLDER" || contract.taskType === "DELETE_FILE") &&
        change.content && change.content.length > 500 &&
        !contract.targetPaths.some((tp) => normPath.startsWith(tp))
      ) {
        forbiddenViolation = `DELETE contract detected new content written to unrelated file "${normPath}"`;
      }

      if (forbiddenViolation) {
        rejected.push({ path: change.path, reason: forbiddenViolation });
        continue;
      }

      accepted.push(change);
    }

    const overCapRejected: Array<{ path: string; reason: string }> = [];
    let finalAccepted = accepted;
    if (accepted.length > contract.maxFiles) {
      finalAccepted = accepted.slice(0, contract.maxFiles);
      for (const overflow of accepted.slice(contract.maxFiles)) {
        overCapRejected.push({
          path: overflow.path,
          reason: `Exceeds contract maxFiles cap of ${contract.maxFiles}. Change dropped by Diff Critic.`,
        });
      }
    }

    const allRejected = [...rejected, ...overCapRejected];
    const log = [
      `[Diff Critic] Contract: ${contract.taskType} | Scope: [${contract.contextScope.slice(0, 3).join(", ")}]`,
      `  ✅ Accepted: ${finalAccepted.length} files`,
      `  ❌ Rejected: ${allRejected.length} files`,
      ...allRejected.map((r) => `    • ${r.path}: ${r.reason}`),
    ].join("\n");

    return { accepted: finalAccepted, rejected: allRejected, log };
  }
}
