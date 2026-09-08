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

    const isExplicitlyPassed = (id: string): boolean => {
      const check = featureChecks.find((c) => c.id === id);
      return check !== undefined && Boolean(check.checked) && check.status === "PASS";
    };

    if (isStandaloneChecklist) {
      return [
        { label: "Analyze user request & standalone goal", checked: true, category: "Search" },
        { label: `Task Routing (Pipeline: STANDALONE, Env: ${executionContract?.environment || "HTML_CSS_JS"})`, checked: true, category: "Search" },
        { label: "HTML5 Document Structure", checked: isExplicitlyPassed("html_structure"), category: "Feature" },
        { label: "CSS Layout & Styling", checked: isExplicitlyPassed("css_styling"), category: "Feature" },
        { label: "JS Interactivity & Events", checked: isExplicitlyPassed("js_interactivity"), category: "Feature" },
        { label: "Standalone Asset Completeness", checked: isExplicitlyPassed("standalone_completeness"), category: "Feature" },
        { label: isClean ? "Zero Syntax Errors" : "Syntax Errors / Build Failed", checked: isClean, category: "Build" },
        { label: "Standalone App Working", checked: featureValidation.overallPassed, category: "Validation" },
      ];
    }

    const items: Array<{ label: string; checked: boolean; category: string }> = [
      { label: "Analyze current code base", checked: true, category: "Search" },
      { label: `Repository search (confidence ${(finalConfidence * 100).toFixed(0)}%)`, checked: finalConfidence >= 0.80, category: "Search" },
      { label: "React component exists", checked: isExplicitlyPassed("component_rendering") || isExplicitlyPassed("orphan_audit"), category: "Feature" },
      { label: "Route exists", checked: isExplicitlyPassed("route_reachability"), category: "Feature" },
      { label: "Imported", checked: isExplicitlyPassed("import_export"), category: "Feature" },
      { label: "Rendered", checked: isExplicitlyPassed("component_rendering"), category: "Feature" },
      { label: "Navigation updated", checked: isExplicitlyPassed("nav_integration"), category: "Feature" },
      { label: "Stylesheets integrated", checked: isExplicitlyPassed("style_integration"), category: "Feature" },
      { label: "API connected", checked: isExplicitlyPassed("api_connection"), category: "Feature" },
      { label: "No orphan components", checked: isExplicitlyPassed("orphan_audit"), category: "Validation" },
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
