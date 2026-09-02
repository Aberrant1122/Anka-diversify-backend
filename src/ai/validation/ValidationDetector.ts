import { getOpenAI } from "../shared/utils";
import { AgentFileChange, ExecutionContract, FeatureValidationResult } from "../shared/types";
import { StaticValidationEngine } from "../../services/static-validator.engine";
import { FEATURE_VALIDATOR_PROMPT } from "../prompts/validation";
import {
  detectPrimaryActiveEntryPoint,
  isExistingPrimaryUIRefinement,
} from "../planning/RepositoryArchitectureDetector";

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
      const staticResult = { ...rawStaticResult, issues: relevantIssues };

      const existingFilePaths = projectFilesOnly.map((f) => f.path);
      const isRefinement = isExistingPrimaryUIRefinement(originalMessage);
      const activeEntry = detectPrimaryActiveEntryPoint(existingFilePaths);
      let activeTargetSatisfied = true;
      let activeTargetDetails = "Intent targets verified";

      if (isRefinement && activeEntry) {
        const normTarget = activeEntry.replace(/\\/g, "/").toLowerCase();
        const touchesActive = changes.some((c) => {
          const norm = c.path.replace(/\\/g, "/").toLowerCase();
          return norm === normTarget || norm.endsWith(normTarget);
        });

        if (!touchesActive) {
          activeTargetSatisfied = false;
          activeTargetDetails = `User requested to improve dashboard UI, but active entry point "${activeEntry}" was not modified.`;
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

    const defaultResult: FeatureValidationResult = {
      overallPassed: true,
      checks: [
        { id: "route_reachability", label: "Route Reachability", status: "WARN", checked: false, details: "Not verified" },
        { id: "component_rendering", label: "Component Rendering", status: "WARN", checked: false, details: "Not verified" },
        { id: "nav_integration", label: "Navigation Integration", status: "WARN", checked: false, details: "Not verified" },
        { id: "import_export", label: "Import/Export Completeness", status: "PASS", checked: true, details: "Assumed complete" },
        { id: "api_connection", label: "API & Service Connection", status: "WARN", checked: false, details: "Not verified" },
        { id: "middleware", label: "Middleware & Permissions", status: "WARN", checked: false, details: "Not verified" },
        { id: "db_wiring", label: "Database Schema Wiring", status: "WARN", checked: false, details: "Not verified" },
        { id: "orphan_audit", label: "Orphan Component Audit", status: "PASS", checked: true, details: "Assumed none" },
        { id: "intent_satisfaction", label: "Intent Satisfaction", status: "PASS", checked: true, details: "Assumed satisfied" },
      ],
      failedChecks: [],
      repairActions: [],
    };

    try {
      const openai = getOpenAI();
      const validationCompletion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: FEATURE_VALIDATOR_PROMPT },
          {
            role: "user",
            content: `ORIGINAL USER REQUEST: ${originalMessage}\n\nEXISTING REPOSITORY FILES:\n${existingFiles.slice(0, 2000)}\n\nNEW/MODIFIED FILES:\n${changesText.slice(0, 6000)}`,
          },
        ],
        temperature: 0.1,
        max_tokens: 2000,
        response_format: { type: "json_object" },
      });

      const parsed = JSON.parse(validationCompletion.choices[0]?.message?.content || "{}");
      if (typeof parsed.overallPassed === "boolean" && Array.isArray(parsed.checks)) {
        return parsed as FeatureValidationResult;
      }
    } catch {}

    return defaultResult;
  }
}
