import { ExecutionContract, FeatureValidationResult } from "../shared/types";

export class PipelineResultBuilder {
  static buildChecklist(
    executionContract: ExecutionContract,
    featureValidation: FeatureValidationResult,
    finalConfidence: number,
    buildSuccess: boolean,
    taskVerified?: boolean,
    repositoryClean?: boolean,
  ): Array<{ label: string; checked: boolean; category: string }> {
    const featureChecks = featureValidation.checks || [];
    const isStandaloneChecklist =
      executionContract?.pipeline === "STANDALONE" || executionContract?.environment === "HTML_CSS_JS";

    const isClean = repositoryClean !== undefined ? Boolean(repositoryClean) : Boolean(buildSuccess);
    const isTaskOk = taskVerified !== undefined ? Boolean(taskVerified) : Boolean(buildSuccess);

    if (isStandaloneChecklist) {
      return [
        { label: "Analyze user request & standalone goal", checked: true, category: "Search" },
        { label: `Task Routing (Pipeline: STANDALONE, Env: ${executionContract?.environment || "HTML_CSS_JS"})`, checked: true, category: "Search" },
        { label: "HTML5 Document Structure", checked: featureChecks.find((c) => c.id === "html_structure")?.status !== "FAIL", category: "Feature" },
        { label: "CSS Layout & Styling", checked: featureChecks.find((c) => c.id === "css_styling")?.status !== "FAIL", category: "Feature" },
        { label: "JS Interactivity & Events", checked: featureChecks.find((c) => c.id === "js_interactivity")?.status !== "FAIL", category: "Feature" },
        { label: "Standalone Asset Completeness", checked: featureChecks.find((c) => c.id === "standalone_completeness")?.status !== "FAIL", category: "Feature" },
        { label: isClean ? "Zero Syntax Errors" : "Syntax Errors / Build Failed", checked: isClean, category: "Build" },
        { label: "Standalone App Working", checked: featureValidation.overallPassed, category: "Validation" },
      ];
    }

    const items: Array<{ label: string; checked: boolean; category: string }> = [
      { label: "Analyze current code base", checked: true, category: "Search" },
      { label: `Repository search (confidence ${(finalConfidence * 100).toFixed(0)}%)`, checked: finalConfidence >= 0.80, category: "Search" },
      { label: "React component exists", checked: featureChecks.find((c) => c.id === "component_rendering")?.status !== "FAIL", category: "Feature" },
      { label: "Route exists", checked: featureChecks.find((c) => c.id === "route_reachability")?.status !== "FAIL", category: "Feature" },
      { label: "Imported", checked: featureChecks.find((c) => c.id === "import_export")?.status !== "FAIL", category: "Feature" },
      { label: "Rendered", checked: featureChecks.find((c) => c.id === "component_rendering")?.status !== "FAIL", category: "Feature" },
      { label: "Navigation updated", checked: featureChecks.find((c) => c.id === "nav_integration")?.status !== "FAIL", category: "Feature" },
      { label: "API connected", checked: featureChecks.find((c) => c.id === "api_connection")?.status !== "FAIL", category: "Feature" },
      { label: "No orphan components", checked: featureChecks.find((c) => c.id === "orphan_audit")?.status !== "FAIL", category: "Validation" },
    ];

    if (isTaskOk && !isClean) {
      items.push({ label: "Requested issue resolved & task verified", checked: true, category: "Build" });
      items.push({ label: "No TS / Compiler Errors", checked: false, category: "Build" });
      items.push({ label: "Full repository build clean", checked: false, category: "Build" });
      items.push({ label: "Feature functional & working", checked: featureValidation.overallPassed, category: "Validation" });
    } else {
      items.push({ label: isClean ? "No TS / Compiler Errors" : "TypeScript / Build Compilation Failed", checked: isClean, category: "Build" });
      items.push({ label: isClean ? "Build passes" : "Build Failed / Flagged", checked: isClean, category: "Build" });
      items.push({ label: "Feature functional & working", checked: isClean && featureValidation.overallPassed, category: "Validation" });
    }

    return items;
  }
}
