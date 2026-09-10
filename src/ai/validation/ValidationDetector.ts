import { AgentFileChange, ExecutionContract, FeatureValidationResult } from "../shared/types";
import { StaticValidationEngine } from "../../services/static-validator.engine";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";
import {
  detectPrimaryActiveEntryPoint,
  detectAllActiveEntryRoots,
  detectRepositoryArchitecture,
} from "../planning/RepositoryArchitectureDetector";

interface FeatureValidationAdvisory {
  findings: Array<{
    id: string;
    label: string;
    assessment: "PASS" | "FAIL" | "WARN";
    details: string;
  }>;
  analysis: string;
  recommendations: string[];
}

const featureValidationAdvisorySchema = {
  name: "FeatureValidationAdvisorySchema",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["findings", "analysis", "recommendations"],
    properties: {
      findings: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "label", "assessment", "details"],
          properties: {
            id: { type: "string", minLength: 1 },
            label: { type: "string", minLength: 1 },
            assessment: { type: "string", enum: ["PASS", "FAIL", "WARN"] },
            details: { type: "string", minLength: 1 },
          },
        },
      },
      analysis: { type: "string", minLength: 1 },
      recommendations: { type: "array", maxItems: 50, items: { type: "string", minLength: 1 } },
    },
  },
  validate: (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { valid: false, errors: ["Feature validation advisory must be an object"] };
    }
    const advisory = value as Record<string, unknown>;
    if (
      Object.keys(advisory).some((key) => !["findings", "analysis", "recommendations"].includes(key)) ||
      !Array.isArray(advisory.findings) ||
      advisory.findings.length > 50 ||
      typeof advisory.analysis !== "string" || !advisory.analysis.trim() ||
      !Array.isArray(advisory.recommendations) ||
      advisory.recommendations.length > 50
    ) {
      return { valid: false, errors: ["Feature validation advisory fields are invalid"] };
    }
    if (advisory.findings.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const finding = item as Record<string, unknown>;
      return (
        Object.keys(finding).some((key) => !["id", "label", "assessment", "details"].includes(key)) ||
        typeof finding.id !== "string" || !finding.id.trim() ||
        typeof finding.label !== "string" || !finding.label.trim() ||
        !["PASS", "FAIL", "WARN"].includes(String(finding.assessment)) ||
        typeof finding.details !== "string" || !finding.details.trim()
      );
    }) || advisory.recommendations.some((item) => typeof item !== "string" || !item.trim())) {
      return { valid: false, errors: ["Feature validation advisory entries are invalid"] };
    }
    return { valid: true, data: advisory as unknown as FeatureValidationAdvisory };
  },
};

export class ValidationDetector {
  static async runFeatureValidation(
    changes: AgentFileChange[],
    snapshot: any,
    originalMessage: string,
    contract?: ExecutionContract,
  ): Promise<FeatureValidationResult> {
    if (!changes.length) {
      return {
        overallPassed: true,
        checks: [],
        failedChecks: [],
        repairActions: [],
      };
    }

    if (contract?.pipeline === "STANDALONE" || contract?.environment === "HTML_CSS_JS") {
      const isDelete = (c: AgentFileChange) => c.action === "delete" || c.isDeleted === true;
      const activeChanges = changes.filter((c) => !isDelete(c) && typeof c.content === "string");
      const hasHtml = activeChanges.some((c) => c.path.endsWith(".html") || c.path.includes("index"));
      const hasCss = activeChanges.some((c) => c.path.endsWith(".css") || (typeof c.content === "string" && c.content.includes("css")));
      const hasJs = activeChanges.some((c) => c.path.endsWith(".js") || (typeof c.content === "string" && c.content.includes("addEventListener")));

      const htmlContent = activeChanges.find((c) => c.path.endsWith(".html"))?.content || "";
      const hasDoctype = /<!doctype\s+html>/i.test(htmlContent) || /<html/i.test(htmlContent);
      const linksStyle = /<link[^>]+href=["']?style\.css["']?/i.test(htmlContent);
      const linksScript = /<script[^>]+src=["']?script\.js["']?/i.test(htmlContent);

      return {
        overallPassed: hasHtml,
        checks: [
          {
            id: "html_structure",
            label: "HTML5 Document Structure",
            status: hasHtml && hasDoctype ? "PASS" : "WARN",
            checked: true,
            details: hasHtml ? (hasDoctype ? "Valid HTML5 doctype & tags present" : "HTML file present") : "Missing index.html",
          },
          {
            id: "css_styling",
            label: "CSS Layout & Styling",
            status: hasCss && linksStyle ? "PASS" : "WARN",
            checked: true,
            details: hasCss ? (linksStyle ? "style.css created and linked in <head>" : "style.css present") : "No standalone CSS file",
          },
          {
            id: "js_interactivity",
            label: "JS Interactivity & Events",
            status: hasJs && linksScript ? "PASS" : "WARN",
            checked: true,
            details: hasJs ? (linksScript ? "script.js created and linked before </body>" : "script.js present") : "No standalone JS file",
          },
          {
            id: "standalone_completeness",
            label: "Standalone Asset Completeness",
            status: hasHtml && (hasCss || hasJs) ? "PASS" : "WARN",
            checked: true,
            details: `Generated ${changes.length} standalone file(s): ${changes.map((c) => c.path).join(", ")}`,
          },
        ],
        failedChecks: [],
        repairActions: [],
      };
    }

    try {
      const rawSnapshotFiles = (snapshot?.keyFiles || snapshot?.repoSnapshot || []) as Array<{ path: string; content?: string }>;
      const projectFilesOnly = rawSnapshotFiles.filter((f) => f.path && !f.path.startsWith("benchmarks/") && !f.path.startsWith("node_modules/"));
      const rawStaticResult = StaticValidationEngine.validate(projectFilesOnly, changes);

      const changedFilePaths = new Set(changes.map((c) => c.path));
      const relevantIssues = rawStaticResult.issues.filter((i) => changedFilePaths.has(i.file));
      const relevantPassed = !relevantIssues.some((i) => i.severity === "FAIL");
      const staticResult = {
        ...rawStaticResult,
        issues: relevantIssues,
        passed: relevantPassed,
        status: relevantIssues.some((i) => i.severity === "FAIL")
          ? ("FAIL" as const)
          : relevantIssues.some((i) => i.severity === "WARNING")
          ? ("WARNING" as const)
          : ("PASS" as const),
      };

      const existingFilePaths = projectFilesOnly.map((f) => f.path);
      const pkgFile = projectFilesOnly.find((f) => f.path && f.path.endsWith("package.json"));
      const arch = detectRepositoryArchitecture(existingFilePaths, pkgFile?.content);
      const isBackendOnly = arch.framework === "EXPRESS" || arch.framework === "NODE_JS";
      const isDelete = (c: AgentFileChange) => c.action === "delete" || c.isDeleted === true;
      const frontendChanges = changes.filter((c) => {
        if (isDelete(c)) return false;
        const norm = c.path.replace(/\\/g, "/").toLowerCase();
        return (
          norm.endsWith(".tsx") ||
          norm.endsWith(".jsx") ||
          norm.endsWith(".css") ||
          norm.endsWith(".scss") ||
          norm.endsWith(".html") ||
          (norm.endsWith(".ts") && !norm.endsWith(".d.ts") && !norm.includes(".test.") && !norm.includes(".spec.")) ||
          (norm.endsWith(".js") && !norm.includes(".test.") && !norm.includes(".spec."))
        );
      });

      const hasFrontendChanges = frontendChanges.length > 0;
      const isUiTaskFromContract = contract
        ? contract.environment === "REACT_TS" || contract.taskType === "NEW_FEATURE"
        : hasFrontendChanges;

      let activeTargetSatisfied = true;
      let activeTargetDetails = "Intent targets verified";

      if (!isBackendOnly && (hasFrontendChanges || isUiTaskFromContract)) {
        const activeRoots = detectAllActiveEntryRoots(existingFilePaths, arch);

        if (activeRoots.length > 0) {

          if (frontendChanges.length === 0) {
            activeTargetSatisfied = false;
            activeTargetDetails = "Modified UI target is not reachable from any active frontend entry point.";
          } else {
            const reachableFiles = StaticValidationEngine.computeReachableFiles(
              activeRoots,
              rawStaticResult.dependencyGraph || new Map(),
            );

            const isChangeActive = (c: AgentFileChange): boolean => {
              const normPath = c.path.replace(/\\/g, "/");
              const lowerPath = normPath.toLowerCase();

              // 1. active entry file itself was modified
              const touchesActiveEntry = activeRoots.some((r) => {
                const normRoot = r.replace(/\\/g, "/").toLowerCase();
                return lowerPath === normRoot || lowerPath.endsWith("/" + normRoot);
              });
              if (touchesActiveEntry) return true;

              // 2. modified existing file is deterministically reachable from active entry
              // 3. newly-created file is integrated by a reachable modified/existing file
              if (reachableFiles.has(lowerPath) || reachableFiles.has(normPath)) {
                return true;
              }

              return false;
            };

            const hasActiveModification = frontendChanges.some(isChangeActive);

            if (!hasActiveModification) {
              activeTargetSatisfied = false;
              activeTargetDetails = "Modified UI target is not reachable from any active frontend entry point.";
            } else {
              activeTargetSatisfied = true;
              activeTargetDetails = "Active target reachability verified";
            }
          }
        }
      }

      const hasMissingNav = staticResult.issues.some((i) => i.checkId === "missing_navigation");
      const hasRouteOrNavChanges = changes.some(
        (c) =>
          c.path.includes("page.") ||
          c.path.includes("Navigation") ||
          c.path.includes("Sidebar") ||
          c.path.includes("Header") ||
          c.path.includes("layout.")
      );

      const checks = [
        {
          id: "import_export",
          label: "Import/Export & Symbol Integrity",
          status: staticResult.issues.some((i) => i.checkId === "broken_import" || i.checkId === "missing_export") ? ("FAIL" as const) : ("PASS" as const),
          checked: true,
          details: staticResult.issues.filter((i) => i.checkId === "broken_import" || i.checkId === "missing_export").map((i) => `${i.file}:${i.line} ${i.reason}`).join("; ") || "All imports and exports resolve cleanly",
        },
        {
          id: "component_rendering",
          label: "Component Rendering Verification",
          status: staticResult.issues.some((i) => i.checkId === "orphan_component") ? ("WARN" as const) : ("PASS" as const),
          checked: true,
          details: staticResult.issues.find((i) => i.checkId === "orphan_component")?.reason || "Component rendering verified",
        },
        {
          id: "circular_dependencies",
          label: "Circular Dependency Check",
          status: staticResult.issues.some((i) => i.checkId === "circular_dependency") ? ("WARN" as const) : ("PASS" as const),
          checked: true,
          details: staticResult.issues.filter((i) => i.checkId === "circular_dependency").map((i) => `${i.file}:${i.line} ${i.reason}`).join("; ") || "No circular dependencies",
        },
        {
          id: "orphan_audit",
          label: "Orphan Component Audit",
          status: staticResult.issues.some((i) => i.checkId === "orphan_component") ? ("WARN" as const) : ("PASS" as const),
          checked: true,
          details: staticResult.issues.filter((i) => i.checkId === "orphan_component").map((i) => `${i.file}:${i.line} ${i.reason}`).join("; ") || "No orphan UI components",
        },
        {
          id: "route_reachability",
          label: "Route Reachability & Dead Routes",
          status: staticResult.issues.some((i) => i.checkId === "dead_route" || i.checkId === "missing_navigation") ? ("WARN" as const) : ("PASS" as const),
          checked: true,
          details: staticResult.issues.filter((i) => i.checkId === "dead_route" || i.checkId === "missing_navigation").map((i) => `${i.file}:${i.line} ${i.reason}`).join("; ") || "All route pages are reachable",
        },
        {
          id: "nav_integration",
          label: "Navigation & Link Integration",
          status: hasMissingNav
            ? ("FAIL" as const)
            : hasRouteOrNavChanges
            ? ("PASS" as const)
            : ("WARN" as const),
          checked: true,
          details: staticResult.issues.find((i) => i.checkId === "missing_navigation")?.reason || "Navigation integration verified",
        },
        {
          id: "style_integration",
          label: "Stylesheet Wiring & Integration",
          status: staticResult.issues.some((i) => i.checkId === "missing_stylesheet_import")
            ? ("FAIL" as const)
            : ("PASS" as const),
          checked: true,
          details: staticResult.issues.find((i) => i.checkId === "missing_stylesheet_import")?.reason || "All created stylesheets are integrated into the render tree",
        },
        {
          id: "intent_satisfaction",
          label: "Active Target Intent Satisfaction",
          status: activeTargetSatisfied ? ("PASS" as const) : ("FAIL" as const),
          checked: true,
          details: activeTargetDetails,
        },
        {
          id: "api_connection",
          label: "API Endpoint Connection",
          status: staticResult.issues.some((i) => i.checkId === "unused_api") ? ("WARN" as const) : ("PASS" as const),
          checked: true,
          details: staticResult.issues.filter((i) => i.checkId === "unused_api").map((i) => `${i.file}:${i.line} ${i.reason}`).join("; ") || "API handlers connected",
        },
        {
          id: "db_wiring",
          label: "Database Schema Wiring",
          status: staticResult.issues.some((i) => i.checkId === "invalid_prisma") ? ("FAIL" as const) : ("PASS" as const),
          checked: true,
          details: staticResult.issues.filter((i) => i.checkId === "invalid_prisma").map((i) => `${i.file}:${i.line} ${i.reason}`).join("; ") || "Prisma schema calls verified",
        },
        {
          id: "missing_provider",
          label: "React Context Provider Verification",
          status: staticResult.issues.some((i) => i.checkId === "missing_provider") ? ("FAIL" as const) : ("PASS" as const),
          checked: true,
          details: staticResult.issues.filter((i) => i.checkId === "missing_provider").map((i) => `${i.file}:${i.line} ${i.reason}`).join("; ") || "Context providers present",
        },
      ];

      const failedChecks = staticResult.issues
        .filter((i) => i.severity === "FAIL")
        .map((i) => `[${i.checkId}] ${i.file}:${i.line} - ${i.reason} (Fix: ${i.suggestedFix})`);

      if (!activeTargetSatisfied) {
        failedChecks.push(`[intent_satisfaction] ${activeTargetDetails}`);
      }

      const repairActions = staticResult.issues
        .filter((i) => i.severity === "FAIL")
        .map((i) => ({
          checkId: i.checkId,
          action: `Fix issue in ${i.file} at line ${i.line}: ${i.suggestedFix}`,
          suggestedTool: "repo_readFile",
        }));

      return {
        overallPassed: Boolean(staticResult.passed && activeTargetSatisfied),
        checks,
        failedChecks,
        repairActions,
      };
    } catch {}

    const changesText = changes
      .map((c) => {
        const isDelete = c.action === "delete" || c.isDeleted === true;
        if (isDelete) {
          return `=== DELETED FILE: ${c.path} ===\nFile removed by agent.`;
        }
        if (typeof c.content === "string") {
          return `=== NEW/MODIFIED FILE: ${c.path} ===\n${c.content.slice(0, 1500)}`;
        }
        return `=== UNKNOWN/INVALID CHANGE: ${c.path} ===\n(Missing file content)`;
      })
      .join("\n\n");
    const snapshotFilesFallback = ((snapshot?.keyFiles || snapshot?.repoSnapshot || []) as Array<{ path: string; content?: string }>);
    const existingFiles = snapshotFilesFallback.map((f) => `${f.path}`).join("\n");

    const unverifiedResult: FeatureValidationResult = {
      overallPassed: false,
      checks: [
        { id: "route_reachability", label: "Route Reachability", status: "WARN", checked: false, details: "Not verified" },
        { id: "component_rendering", label: "Component Rendering", status: "WARN", checked: false, details: "Not verified" },
        { id: "nav_integration", label: "Navigation Integration", status: "WARN", checked: false, details: "Not verified" },
        { id: "import_export", label: "Import/Export Completeness", status: "WARN", checked: false, details: "Not verified" },
        { id: "api_connection", label: "API & Service Connection", status: "WARN", checked: false, details: "Not verified" },
        { id: "middleware", label: "Middleware & Permissions", status: "WARN", checked: false, details: "Not verified" },
        { id: "db_wiring", label: "Database Schema Wiring", status: "WARN", checked: false, details: "Not verified" },
        { id: "orphan_audit", label: "Orphan Component Audit", status: "WARN", checked: false, details: "Not verified" },
        { id: "intent_satisfaction", label: "Intent Satisfaction", status: "WARN", checked: false, details: "Not verified" },
      ],
      failedChecks: ["Deterministic feature validation was unavailable."],
      repairActions: [],
    };

    try {
      const advisory = await LLMGateway.getInstance().callStructured<FeatureValidationAdvisory>({
        stage: PipelineStages.FEATURE_VALIDATION,
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `You are an advisory feature and integration reviewer.
Analyze the supplied repository context and proposed changes for suspected integration problems.
Your response is advisory only and does not establish validation success or failure.
Return findings with an advisory assessment, analysis, and recommendations.`,
          },
          {
            role: "user",
            content: `ORIGINAL USER REQUEST: ${originalMessage}\n\nEXISTING REPOSITORY FILES:\n${existingFiles.slice(0, 2000)}\n\nNEW/MODIFIED FILES:\n${changesText.slice(0, 6000)}`,
          },
        ],
        temperature: 0.1,
        maxTokens: 2000,
        schema: featureValidationAdvisorySchema,
      });

      const advisoryChecks = advisory.content.findings.map((finding, index) => ({
        id: `model_advisory_${index + 1}_${finding.id}`,
        label: finding.label,
        status: "WARN" as const,
        checked: false,
        details: `[MODEL_ADVISORY:${finding.assessment}] ${finding.details}`,
      }));
      const advisorySummary = [
        advisory.content.analysis.trim(),
        ...advisory.content.recommendations.map((item) => `Recommendation: ${item}`),
      ].filter(Boolean).join(" ");
      return {
        ...unverifiedResult,
        checks: advisoryChecks.length > 0
          ? advisoryChecks
          : unverifiedResult.checks,
        failedChecks: [
          ...unverifiedResult.failedChecks,
          ...(advisorySummary ? [`Model advisory: ${advisorySummary}`] : []),
        ],
      };
    } catch {}

    return unverifiedResult;
  }
}
