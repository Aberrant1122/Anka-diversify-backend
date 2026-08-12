export const FEATURE_VALIDATOR_PROMPT = `You are an Autonomous Feature & Integration Validator.
Validate generated code changes against existing codebase structure.

Respond ONLY with valid JSON matching this schema:
{
  "overallPassed": boolean,
  "checks": [
    {
      "id": "string",
      "label": "string",
      "status": "PASS" | "FAIL" | "WARN",
      "checked": boolean,
      "details": "string"
    }
  ],
  "failedChecks": ["string"],
  "repairActions": [
    {
      "checkId": "string",
      "action": "string",
      "suggestedTool": "string"
    }
  ]
}`;

export function buildContractGuardrailSection(contract: {
  goal: string;
  taskType: string;
  pipeline?: string;
  environment?: string;
  expectedFiles?: string[];
  allowedActions: string[];
  forbiddenActions: string[];
  maxFiles: number;
  targetPaths: string[];
  contextScope: string[];
}): string {
  const isStandalone = contract.pipeline === "STANDALONE";
  const envHint = contract.environment ? ` [Environment: ${contract.environment}]` : "";

  return `
══════════════════════════════════════════════════════════
EXECUTION CONTRACT — YOU MUST FOLLOW THIS EXACTLY
══════════════════════════════════════════════════════════
Goal:           ${contract.goal}
Task Type:      ${contract.taskType}
Pipeline:       ${contract.pipeline || "REPOSITORY"}${envHint}
Target Paths:   ${contract.targetPaths.length > 0 ? contract.targetPaths.join(", ") : "(determined by task)"}
Expected Files: ${contract.expectedFiles?.length ? contract.expectedFiles.join(", ") : "(as needed)"}
Max Files:      ${contract.maxFiles} — Do NOT produce more than ${contract.maxFiles} changed files.

ALLOWED Actions (only these are permitted):
${contract.allowedActions.map((a) => `  ✓ ${a}`).join("\n")}

FORBIDDEN Actions (any output implying these will be REJECTED by the Diff Critic):
${contract.forbiddenActions.map((a) => `  ✗ ${a}`).join("\n")}

${isStandalone ? `STANDALONE ARCHITECTURE MANDATE:
- This is a STANDALONE application request (${contract.environment || "HTML/CSS/JS"}).
- Do NOT assume or reference existing React components, Next.js routes, or TypeScript app structures.
- Generate standard, self-contained files: e.g. "index.html", "style.css", "script.js".
- Ensure "index.html" links "style.css" via <link rel="stylesheet" href="style.css"> and "script.js" via <script src="script.js"></script>.
` : `Context Scope (only files from these paths are relevant to this task):
${contract.contextScope.length > 0 ? contract.contextScope.map((p) => `  • ${p}`).join("\n") : "  • (entire project)"}`}

CRITICAL ANTI-HALLUCINATION RULES:
1. Every file in your "changes" array MUST align with the Goal and Target Environment.
2. Do NOT invent or import non-existent files, functions, components, or npm packages.
3. Do NOT generate files for React components, pages, or modules unless explicitly part of the request.
4. Honor the maxFiles limit (${contract.maxFiles}).
5. Generate COMPLETE, 100% working code from line 1 to the end — NO placeholders, NO "// ... existing code" comments.
══════════════════════════════════════════════════════════
`;
}
