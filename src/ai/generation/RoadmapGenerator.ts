import { RoadmapStep, ExecutionContract } from "../shared/types";

export class RoadmapGenerator {
  static createDefaultRoadmap(contract?: ExecutionContract, message: string = ""): RoadmapStep[] {
    const isStandaloneWeb = contract?.pipeline === "STANDALONE" || contract?.environment === "HTML_CSS_JS";
    const isDeleteTask = contract?.taskType === "DELETE_FILE" || contract?.taskType === "DELETE_FOLDER";

    if (isDeleteTask) {
      return [
        { phase: 1, title: "Identify Target Files & References", layer: "Controller", targetFiles: contract?.targetPaths || [], description: "Identify target files and directories for deletion" },
        { phase: 2, title: "Remove Target Files & Clean References", layer: "Controller", targetFiles: contract?.targetPaths || [], description: "Delete specified files/directories and update imports" },
      ];
    }
    if (isStandaloneWeb) {
      return [
        { phase: 1, title: "HTML5 Document Structure", layer: "UI", targetFiles: ["index.html"], description: "Create responsive HTML5 page structure" },
        { phase: 2, title: "CSS Layout & Styling", layer: "UI", targetFiles: ["style.css"], description: "Implement visual styles and layout" },
        { phase: 3, title: "JS Interactivity & Events", layer: "UI", targetFiles: ["script.js"], description: "Add interactivity and application logic" },
        { phase: 4, title: "Standalone Application Assembly", layer: "UI", targetFiles: ["index.html", "style.css", "script.js"], description: "Assemble complete standalone web application" },
      ];
    }
    return [
      { phase: 1, title: "Analysis & Types", layer: "Schema", targetFiles: [], description: "Define necessary interfaces and models" },
      { phase: 2, title: "Service Implementation", layer: "Service", targetFiles: [], description: "Implement business logic" },
      { phase: 3, title: "Controller & Route Handling", layer: "Controller", targetFiles: [], description: "Expose API endpoints and validate inputs" },
    ];
  }
}
