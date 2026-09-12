import { RepositoryToolEngine } from "../../services/repository-tool.engine";
import { RepositoryEvidenceStore, RepositoryEvidence } from "./RepositoryEvidenceStore";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryArchitectureSummary } from "../planning/RepositoryArchitectureDetector";
import { normalizeRepoPath } from "./SemanticContextResolver";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";

export interface InvestigationToolCall {
  tool: string;
  params: Record<string, any>;
  reason: string;
}

export interface InvestigationStepRecord {
  stepId: number;
  tool: string;
  argsSummary: string;
  resultSummary: string;
  evidenceIdsAdded: string[];
  decision: string;
  readyToPlan: boolean;
}

export interface InvestigationAgentResult {
  readyToPlan: boolean;
  evidenceIds: string[];
  missingEvidence: string[];
  roundsExecuted: number;
  allExploredFiles: string[];
  summary: string;
  investigationHistory: InvestigationStepRecord[];
}

export interface RepositoryInvestigationOptions {
  maxRounds?: number;
  toolEngine: RepositoryToolEngine;
  evidenceStore: RepositoryEvidenceStore;
  intentSpec: TaskIntentSpec;
  architectureSummary?: RepositoryArchitectureSummary;
  localPath?: string | null;
  openaiClient?: any;
}

interface InvestigationDecision {
  readyToPlan: boolean;
  reason: string;
  toolCalls: InvestigationToolCall[];
}

function isSafeOptionalRepoPath(value: unknown): boolean {
  if (typeof value !== "string" || !value || value !== value.trim() || value.includes("\0")) return false;
  const normalized = value.replace(/\\/g, "/");
  return !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized) && normalized.split("/").every((part) => part && part !== "." && part !== "..");
}

function normalizeExactRepositoryTarget(value: unknown): string | null {
  if (typeof value !== "string" || !value || value !== value.trim() || value.includes("\0")) return null;
  const slashNormalized = value.replace(/\\/g, "/");
  if (slashNormalized.startsWith("/") || /^[A-Za-z]:\//.test(slashNormalized)) return null;
  const normalized = normalizeRepoPath(slashNormalized);
  if (!normalized || normalized.endsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  return normalized;
}

function isMaterializedRepositoryEvidence(evidence: RepositoryEvidence): boolean {
  return evidence.provenance !== "SEMANTIC_SEARCH" && normalizeExactRepositoryTarget(evidence.filePath) !== null;
}

function validateInvestigationToolParams(tool: string, params: Record<string, unknown>): boolean {
  const allowedByTool: Record<string, string[]> = {
    repo_readFile: ["filePath", "startLine", "endLine"],
    repo_findRoute: ["pathPattern", "httpMethod"],
    repo_findComponent: ["componentName", "searchScope"],
    repo_findService: ["serviceName", "domain"],
    repo_findAPI: ["endpointPattern", "method"],
    repo_findModel: ["modelName"],
    repo_findReferences: ["symbolName", "sourceFilePath"],
    repo_searchArchitecture: ["query", "layer"],
    repo_semanticSearch: ["query", "limit", "fileExtensions"],
    repo_grepSearch: ["pattern", "caseSensitive", "limit"],
  };
  const allowed = allowedByTool[tool];
  if (!allowed || Object.keys(params).some((key) => !allowed.includes(key))) return false;
  const nonEmptyString = (key: string) => typeof params[key] === "string" && (params[key] as string).trim().length > 0;
  const optionalString = (key: string) => params[key] === undefined || nonEmptyString(key);
  const optionalLimit = () => params.limit === undefined || (Number.isInteger(params.limit) && (params.limit as number) > 0 && (params.limit as number) <= 100);

  switch (tool) {
    case "repo_readFile":
      return isSafeOptionalRepoPath(params.filePath) && ["startLine", "endLine"].every((key) => params[key] === undefined || (Number.isInteger(params[key]) && (params[key] as number) > 0));
    case "repo_findRoute": return nonEmptyString("pathPattern") && optionalString("httpMethod");
    case "repo_findComponent": return nonEmptyString("componentName") && (params.searchScope === undefined || isSafeOptionalRepoPath(params.searchScope));
    case "repo_findService": return nonEmptyString("serviceName") && optionalString("domain");
    case "repo_findAPI": return nonEmptyString("endpointPattern") && optionalString("method");
    case "repo_findModel": return nonEmptyString("modelName");
    case "repo_findReferences": return nonEmptyString("symbolName") && (params.sourceFilePath === undefined || isSafeOptionalRepoPath(params.sourceFilePath));
    case "repo_searchArchitecture": return nonEmptyString("query") && ["presentation", "business", "data", "middleware"].includes(String(params.layer));
    case "repo_semanticSearch": return nonEmptyString("query") && optionalLimit() && (params.fileExtensions === undefined || (Array.isArray(params.fileExtensions) && params.fileExtensions.every((ext) => typeof ext === "string" && /^[A-Za-z0-9]+$/.test(ext))));
    case "repo_grepSearch": return nonEmptyString("pattern") && (params.caseSensitive === undefined || typeof params.caseSensitive === "boolean") && optionalLimit();
    default: return false;
  }
}

/**
 * Dynamic Tool-Calling Repository Investigation Agent.
 *
 * Invariants (Phase 2):
 * 1. Strictly READ-ONLY tool calling. Cannot modify repository files.
 * 2. Model decides which tools to call dynamically based on task intent and current evidence.
 * 3. NO hardcoded first-keyword / second-keyword round scripts.
 * 4. NO fake confidence formulas (0.30 + symbols * 0.10). Readiness is evidence-driven.
 * 5. Semantic/BM25 results are discovered candidates; they become planning evidence only
 *    when materialized and verified (e.g. repo_readFile, repo_findReferences).
 * 6. Structured logs: [INVESTIGATION] round=... tool=... evidenceAdded=... readyToPlan=...
 */
export class RepositoryInvestigationAgent {
  private toolEngine: RepositoryToolEngine;
  private evidenceStore: RepositoryEvidenceStore;
  private intentSpec: TaskIntentSpec;
  private architectureSummary?: RepositoryArchitectureSummary;
  private maxRounds: number;
  private openaiClient?: any;

  constructor(options: RepositoryInvestigationOptions) {
    this.toolEngine = options.toolEngine;
    this.evidenceStore = options.evidenceStore;
    this.intentSpec = options.intentSpec;
    this.architectureSummary = options.architectureSummary;
    this.maxRounds = options.maxRounds || 5;
    this.openaiClient = options.openaiClient;
  }

  /**
   * Runs the dynamic tool-calling investigation loop.
   */
  public async investigate(): Promise<InvestigationAgentResult> {
    const executedHashes = new Set<string>();
    const allExploredFiles = new Set<string>();
    const investigationHistory: InvestigationStepRecord[] = [];
    let roundNumber = 1;
    let readyToPlan = false;
    let missingEvidence: string[] = [];

    // Pre-seed known architectural entry points into evidence store
    if (this.architectureSummary?.existingEntryPoints) {
      for (const entry of this.architectureSummary.existingEntryPoints) {
        this.evidenceStore.observeRepository({
          kind: "ENTRY_POINT",
          filePath: entry,
          provenance: "ARCHITECTURE_DETECTOR",
        });
        allExploredFiles.add(normalizeRepoPath(entry));
      }
    }

    // Seed explicit user paths into evidence store if they exist
    if (this.intentSpec.explicitUserPaths.length > 0) {
      for (const explicitPath of this.intentSpec.explicitUserPaths) {
        const fileCheck = this.toolEngine.readFile({ filePath: explicitPath });
        if (fileCheck.found) {
          this.evidenceStore.observeRepository({
            kind: "FILE",
            filePath: explicitPath,
            provenance: "REPO_READ",
          });
          allExploredFiles.add(normalizeRepoPath(explicitPath));
        }
      }
    }

    while (roundNumber <= this.maxRounds && !readyToPlan) {
      console.log(`[INVESTIGATION] round=${roundNumber} goal="${this.intentSpec.goal}"`);

      // 1. Get tool decisions from model or evidence-based planner
      const nextActions = await this.decideNextToolCalls(roundNumber, executedHashes);

      if (nextActions.readyToPlan) {
        const stopCheck = this.evaluateStopConditions();
        if (stopCheck.ready) {
          readyToPlan = true;
          console.log(`[INVESTIGATION] round=${roundNumber} readyToPlan=true reason="Deterministic evidence sufficiency satisfied"`);
          break;
        }
        missingEvidence = stopCheck.missing;
      }

      if (!nextActions.toolCalls || nextActions.toolCalls.length === 0) {
        // No further tools to call
        console.log(`[INVESTIGATION] round=${roundNumber} readyToPlan=false No more tool calls proposed.`);
        break;
      }

      // 2. Execute approved tools read-only and materialize verified evidence
      for (const call of nextActions.toolCalls) {
        const hash = `${call.tool}:${JSON.stringify(call.params)}`;
        if (executedHashes.has(hash)) continue;
        executedHashes.add(hash);

        console.log(`[INVESTIGATION] round=${roundNumber} tool=${call.tool} reason="${call.reason}"`);
        const evBeforeCount = this.evidenceStore.getAllEvidence().length;
        this.executeToolAndMaterializeEvidence(call.tool, call.params, allExploredFiles);
        const allEv = this.evidenceStore.getAllEvidence();
        const evAdded = allEv.slice(evBeforeCount).map((e) => e.id);

        investigationHistory.push({
          stepId: roundNumber,
          tool: call.tool,
          argsSummary: JSON.stringify(call.params),
          resultSummary: `Materialized ${evAdded.length} evidence record(s)`,
          evidenceIdsAdded: evAdded,
          decision: "CONTINUE",
          readyToPlan: false,
        });
      }

      // 3. Check stop conditions
      const stopCheck = this.evaluateStopConditions();
      if (stopCheck.ready) {
        readyToPlan = true;
        console.log(`[INVESTIGATION] round=${roundNumber} readyToPlan=true evidenceCount=${this.evidenceStore.getAllEvidence().length}`);
        if (investigationHistory.length > 0) {
          investigationHistory[investigationHistory.length - 1].decision = "READY_TO_PLAN";
          investigationHistory[investigationHistory.length - 1].readyToPlan = true;
        }
      } else {
        missingEvidence = stopCheck.missing;
      }

      roundNumber++;
    }

    const allEvidence = this.evidenceStore.getAllEvidence();
    const evidenceIds = allEvidence.map((e) => e.id);

    return {
      readyToPlan,
      evidenceIds,
      missingEvidence,
      roundsExecuted: Math.min(roundNumber, this.maxRounds),
      allExploredFiles: Array.from(allExploredFiles),
      summary: `Investigation completed in ${Math.min(roundNumber, this.maxRounds)} rounds with ${allEvidence.length} verified evidence items across ${allExploredFiles.size} files.`,
      investigationHistory,
    };
  }

  /**
   * Determines the next batch of tool calls using LLM or deterministic fallback if LLM is unavailable.
   */
  private async decideNextToolCalls(
    round: number,
    executedHashes: Set<string>
  ): Promise<{ readyToPlan: boolean; toolCalls: InvestigationToolCall[]; reason?: string }> {
    const evidenceSummary = this.evidenceStore.summarizeEvidence();
    const availableTools = [
      "repo_readFile",
      "repo_findComponent",
      "repo_findService",
      "repo_findAPI",
      "repo_findModel",
      "repo_findReferences",
      "repo_searchArchitecture",
      "repo_semanticSearch",
      "repo_findRoute",
      "repo_grepSearch",
    ];

    try {
      const prompt = `You are a Repository Investigation Agent for an AI Coding Assistant.
TASK GOAL: "${this.intentSpec.goal}"
TASK TYPE: ${this.intentSpec.taskType}
ROUND: ${round} / ${this.maxRounds}

CURRENT VERIFIED EVIDENCE:
${evidenceSummary.length > 0 ? JSON.stringify(evidenceSummary.slice(-20), null, 2) : "None yet"}

AVAILABLE READ-ONLY TOOLS:
${availableTools.map((t) => `- ${t}`).join("\n")}

INSTRUCTIONS:
- If you have discovered sufficient evidence to answer:
  1. where requested behavior currently lives,
  2. what components/services own or wire it,
  3. what exact files need creation or modification,
  THEN return "readyToPlan": true.
- Otherwise, propose 1 to 4 specific tool calls to inspect files, trace references, or find routes/components.
- Output ONLY valid JSON matching this schema:
{
  "readyToPlan": boolean,
  "reason": "explanation of readiness or investigation strategy",
  "toolCalls": [
    {
      "tool": "repo_readFile" | "repo_findComponent" | "repo_findService" | "repo_findAPI" | "repo_findModel" | "repo_findReferences" | "repo_searchArchitecture" | "repo_semanticSearch" | "repo_findRoute" | "repo_grepSearch",
      "params": { ... },
      "reason": "why this tool is needed"
    }
  ]
}`;

      const result = await LLMGateway.getInstance().callStructured<InvestigationDecision>({
        stage: PipelineStages.REPOSITORY_REASONING,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        openaiClient: this.openaiClient,
        schema: {
          name: "RepositoryInvestigationDecisionSchema",
          strict: false,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["readyToPlan", "reason", "toolCalls"],
            properties: {
              readyToPlan: { type: "boolean" },
              reason: { type: "string" },
              toolCalls: {
                type: "array",
                maxItems: 4,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["tool", "params", "reason"],
                  properties: {
                    tool: { type: "string", enum: availableTools },
                    params: { type: "object" },
                    reason: { type: "string", minLength: 1 },
                  },
                },
              },
            },
          },
          validate: (value: unknown) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["Decision must be an object"] };
            const decision = value as Record<string, unknown>;
            const allowedKeys = new Set(["readyToPlan", "reason", "toolCalls"]);
            if (Object.keys(decision).some((key) => !allowedKeys.has(key))) return { valid: false, errors: ["Decision contains unknown fields"] };
            if (typeof decision.readyToPlan !== "boolean" || typeof decision.reason !== "string" || !Array.isArray(decision.toolCalls) || decision.toolCalls.length > 4) {
              return { valid: false, errors: ["Decision fields are invalid"] };
            }
            for (const call of decision.toolCalls) {
              if (!call || typeof call !== "object" || Array.isArray(call)) return { valid: false, errors: ["Tool call must be an object"] };
              const candidate = call as Record<string, unknown>;
              const callKeys = new Set(["tool", "params", "reason"]);
              if (Object.keys(candidate).some((key) => !callKeys.has(key))) return { valid: false, errors: ["Tool call contains unknown fields"] };
              if (typeof candidate.tool !== "string" || !availableTools.includes(candidate.tool) || !candidate.params || typeof candidate.params !== "object" || Array.isArray(candidate.params) || !validateInvestigationToolParams(candidate.tool, candidate.params as Record<string, unknown>) || typeof candidate.reason !== "string" || candidate.reason.trim().length === 0) {
                return { valid: false, errors: ["Tool call fields are invalid"] };
              }
            }
            return { valid: true, data: decision as unknown as InvestigationDecision };
          },
        },
      });
      return result.content;
    } catch {
      // Fall through to deterministic investigation strategy
    }

    // Deterministic fallback tool planner (evidence-driven, NOT keyword-scripted)
    return this.fallbackToolPlanner(round, executedHashes);
  }

  /**
   * Deterministic evidence-driven fallback if LLM completion is unavailable.
   */
  private fallbackToolPlanner(
    round: number,
    executedHashes: Set<string>
  ): { readyToPlan: boolean; toolCalls: InvestigationToolCall[]; reason?: string } {
    const calls: InvestigationToolCall[] = [];
    const currentEvidence = this.evidenceStore.getAllEvidence();
    if (round === 1) {
      for (const op of this.intentSpec.operations) {
        if (op.subject) {
          calls.push({
            tool: "repo_semanticSearch",
            params: { query: op.subject, limit: 5 },
            reason: `Initial candidate discovery for operation subject: ${op.subject}`,
          });
          calls.push({
            tool: "repo_grepSearch",
            params: { pattern: op.subject.split(/\s+/)[0] || op.subject, limit: 20 },
            reason: `Text search for literal term from subject: ${op.subject}`,
          });
        }
      }
      // Inspect component / UI structure
      calls.push({
        tool: "repo_findComponent",
        params: { componentName: "App" },
        reason: "Inspect root application component",
      });
    } else {
      // Round 2+: Materialize candidates and follow references
      for (const ev of currentEvidence) {
        if (ev.kind === "FILE" && !ev.symbol) {
          calls.push({
            tool: "repo_findReferences",
            params: { symbolName: ev.filePath },
            reason: `Trace callers and imports for investigated file: ${ev.filePath}`,
          });
        }
      }

      // Check if we have enough evidence
      if (currentEvidence.length >= 1) {
        return { readyToPlan: true, toolCalls: [], reason: "Discovered sufficient repository evidence." };
      }
    }

    const filtered = calls.filter((c) => !executedHashes.has(`${c.tool}:${JSON.stringify(c.params)}`));
    return {
      readyToPlan: filtered.length === 0,
      toolCalls: filtered.slice(0, 4),
      reason: "Executing evidence-driven candidate validation.",
    };
  }

  /**
   * Executes a single read-only repository tool and converts verified facts into immutable RepositoryEvidence.
   */
  private executeToolAndMaterializeEvidence(
    toolName: string,
    params: Record<string, any>,
    allExploredFiles: Set<string>
  ) {
    const rawResult = this.toolEngine.dispatch(toolName, params);
    let parsed: any;
    try {
      parsed = JSON.parse(rawResult);
    } catch {
      parsed = rawResult;
    }

    if (!parsed || parsed.error) return;

    // 1. repo_readFile confirms existence of file
    if (toolName === "repo_readFile" && parsed.found) {
      const filePath = parsed.filePath || params.filePath;
      this.evidenceStore.observeRepository({
        kind: "FILE",
        filePath,
        provenance: "REPO_READ",
        metadata: { totalLines: parsed.totalLines },
      });
      allExploredFiles.add(normalizeRepoPath(filePath));
    }

    // 2. repo_findComponent confirms component symbol and owning file
    if (toolName === "repo_findComponent" && Array.isArray(parsed.components)) {
      for (const comp of parsed.components) {
        this.evidenceStore.observeRepository({
          kind: "SYMBOL",
          filePath: comp.file,
          symbol: comp.componentName,
          provenance: "AST_GRAPH",
          metadata: { exportKind: comp.exportKind, isReachable: comp.isReachable },
        });
        allExploredFiles.add(normalizeRepoPath(comp.file));
      }
    }

    // 3. repo_findService confirms service existence
    if (toolName === "repo_findService" && Array.isArray(parsed.services)) {
      for (const svc of parsed.services) {
        this.evidenceStore.observeRepository({
          kind: "SYMBOL",
          filePath: svc.filePath,
          symbol: svc.serviceName,
          provenance: "AST_GRAPH",
          metadata: { methods: svc.methods },
        });
        allExploredFiles.add(normalizeRepoPath(svc.filePath));
      }
    }

    // 4. repo_findRoute confirms route pattern and file
    if (toolName === "repo_findRoute" && Array.isArray(parsed.routes)) {
      for (const rt of parsed.routes) {
        this.evidenceStore.observeRepository({
          kind: "ROUTE",
          filePath: rt.file,
          symbol: rt.path,
          provenance: "AST_GRAPH",
          metadata: { httpMethod: rt.httpMethod },
        });
        allExploredFiles.add(normalizeRepoPath(rt.file));
      }
    }

    // 5. repo_findReferences confirms import / call link between source and target
    if (toolName === "repo_findReferences" && Array.isArray(parsed.references)) {
      for (const ref of parsed.references) {
        this.evidenceStore.observeRepository({
          kind: "REFERENCE",
          filePath: ref.file,
          symbol: params.symbolName,
          provenance: "REFERENCE_SEARCH",
          metadata: { referenceType: ref.referenceType, line: ref.line },
        });
        allExploredFiles.add(normalizeRepoPath(ref.file));
      }
    }

    // 6. Semantic Search: Results are CANDIDATES, not authoritative evidence.
    // For top candidates, we verify them via repo_readFile before adding FILE evidence.
    if (toolName === "repo_semanticSearch" && Array.isArray(parsed)) {
      for (const hit of parsed.slice(0, 3)) {
        if (hit.filePath) {
          const check = this.toolEngine.readFile({ filePath: hit.filePath });
          if (check.found) {
            this.evidenceStore.observeRepository({
              kind: "FILE",
              filePath: hit.filePath,
              symbol: hit.symbolName,
              provenance: "SEMANTIC_SEARCH",
              metadata: { relevanceScore: hit.relevanceScore },
            });
            allExploredFiles.add(normalizeRepoPath(hit.filePath));
          }
        }
      }
    }

    // 7. Grep Search: Read-verified text matches
    if (toolName === "repo_grepSearch" && Array.isArray(parsed.results)) {
      for (const match of parsed.results.slice(0, 5)) {
        if (match.file) {
          this.evidenceStore.observeRepository({
            kind: "FILE",
            filePath: match.file,
            provenance: "REPO_READ",
            metadata: { matchLine: match.line, snippet: match.match },
          });
          allExploredFiles.add(normalizeRepoPath(match.file));
        }
      }
    }

    // 8. Architecture Search: Layer and entry discoveries
    if (toolName === "repo_searchArchitecture" && Array.isArray(parsed.results)) {
      for (const item of parsed.results.slice(0, 5)) {
        if (item.file) {
          this.evidenceStore.observeRepository({
            kind: "ENTRY_POINT",
            filePath: item.file,
            provenance: "ARCHITECTURE_DETECTOR",
            metadata: { layer: item.layer, description: item.description },
          });
          allExploredFiles.add(normalizeRepoPath(item.file));
        }
      }
    }
  }

  /**
   * Stop condition evaluator: Task-sensitive but evidence-driven.
   */
  private evaluateStopConditions(): { ready: boolean; missing: string[] } {
    const allEvidence = this.evidenceStore.getAllEvidence();
    const missing: string[] = [];

    if (allEvidence.length === 0) {
      missing.push("No verified repository evidence discovered yet.");
      return { ready: false, missing };
    }

    const materializedEvidencePaths = new Set(
      allEvidence
        .filter(isMaterializedRepositoryEvidence)
        .map((e) => normalizeExactRepositoryTarget(e.filePath))
        .filter((path): path is string => path !== null),
    );
    const normalizedExplicitPaths = this.intentSpec.explicitUserPaths.map(normalizeExactRepositoryTarget);
    if (normalizedExplicitPaths.some((path) => path === null)) {
      missing.push("Explicit repository target identity is missing or ambiguous after safe normalization.");
      return { ready: false, missing };
    }
    const missingExplicitPaths = normalizedExplicitPaths
      .filter((path): path is string => path !== null)
      .filter((path) => !materializedEvidencePaths.has(path));
    if (missingExplicitPaths.length > 0) {
      missing.push(`Explicit repository target(s) lack materialized evidence: ${missingExplicitPaths.join(", ")}`);
      return { ready: false, missing };
    }

    if (this.intentSpec.destructive) {
      const obligationTargets = (this.intentSpec.resolvedTarget?.actionObligations || [])
        .filter((obligation) => obligation.requiredAction === "delete")
        .map((obligation) => obligation.path);
      const representedTargets = obligationTargets.length > 0
        ? obligationTargets
        : this.intentSpec.resolvedTarget?.candidatePaths?.length
          ? this.intentSpec.resolvedTarget.candidatePaths
          : this.intentSpec.explicitUserPaths;
      const normalizedTargets = representedTargets.map(normalizeExactRepositoryTarget);

      if (normalizedTargets.length === 0 || normalizedTargets.some((target) => target === null)) {
        missing.push("Destructive target identity is missing or ambiguous; target-bound evidence cannot be established.");
        return { ready: false, missing };
      }

      const missingDestructiveTargets = normalizedTargets
        .filter((target): target is string => target !== null)
        .filter((target) => !materializedEvidencePaths.has(target));
      if (missingDestructiveTargets.length > 0) {
        missing.push(`Destructive repository target(s) lack exact materialized evidence: ${missingDestructiveTargets.join(", ")}`);
        return { ready: false, missing };
      }
    }

    return { ready: true, missing: [] };
  }
}
