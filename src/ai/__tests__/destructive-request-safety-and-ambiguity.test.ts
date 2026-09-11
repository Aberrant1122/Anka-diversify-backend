import { DestructiveSafetyEvaluator } from "../classification/DestructiveSafetyEvaluator";
import { IntentClassifier } from "../classification/IntentClassifier";
import { buildExecutionContract } from "../contracts/ExecutionContractBuilder";
import { TaskClassificationResult } from "../shared/types";
import { ManifestValidator } from "../../services/manifest-validator";
import { FileManifest } from "../../types";
import { TargetScopeExpander } from "../contracts/TargetScopeExpander";
import * as sharedUtils from "../shared/utils";

const mockOpenAI = {
  chat: {
    completions: {
      create: jest.fn(),
    },
  },
};

describe("Cluster C: Ambiguous Destructive Request Safety & Delete Authority", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(sharedUtils, "getOpenAI").mockReturnValue(mockOpenAI as any);

    mockOpenAI.chat.completions.create.mockImplementation(async (params: any) => {
      const userMsg = params.messages.find((m: any) => m.role === "user")?.content || "";
      const match = userMsg.match(/USER REQUEST: (.*?)(?:\nPROJECT:|$)/s);
      const text = (match ? match[1] : userMsg).trim();

      let taskType = "NEW_FEATURE";
      let targetPath: string | undefined = undefined;

      if (/remove\s+the\s+unused\s+import/i.test(text)) {
        taskType = "BUG_FIX";
        targetPath = "app/page.tsx";
      } else if (/remove\s+extra\s+padding/i.test(text)) {
        taskType = "BUG_FIX";
        targetPath = "src/components/Card.tsx";
      } else if (/replace\s+the\s+deprecated\s+activity\s+widget/i.test(text)) {
        taskType = "REFACTOR";
      } else if (/delete\s+the\s+old\s+stuff|delete\s+deprecated\s+things/i.test(text)) {
        taskType = "DELETE_FOLDER";
      } else if (/delete|remove/i.test(text)) {
        taskType = "DELETE_FILE";
        const explicitMatch = text.match(/(?:delete|remove)\s+([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)/i);
        if (explicitMatch) {
          targetPath = explicitMatch[1];
        }
      }

      const result = {
        taskType,
        risk: "LOW",
        estimatedComplexity: "SMALL",
        intent: taskType,
        confidence: 0.95,
        requiresClarification: false,
        reasoning: `Mock classified as ${taskType}`,
        targetPath,
      };

      return {
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: {
              content: JSON.stringify(result),
            },
          },
        ],
      };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
  const sampleRepoFiles = [
    "src/components/activity/LegacyActivityWidget.tsx",
    "src/components/activity/legacy-activity-widget.css",
    "src/components/Card.tsx",
    "src/components/Button.tsx",
    "app/page.tsx",
    "app/tasks/page.tsx",
    "lib/legacy-cache.ts",
    "data/archived-records.ts",
    "types/legacy-schema.ts",
  ];

  describe("1 & 5 & 6: Vague, Nonexistent, and Semantic Retrieval Safety", () => {
    it("1. 'Delete the old stuff and clean everything up.' triggers requiresClarification=true without destructive authority", async () => {
      const message = "Delete the old stuff and clean everything up.";
      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        sampleRepoFiles
      );

      expect(classification.requiresClarification).toBe(true);
      expect(classification.question).toMatch(/does not identify which files or components/i);

      // Verify ExecutionContractBuilder fails closed when requiresClarification is true
      const contract = buildExecutionContract(classification, message, sampleRepoFiles);
      expect(contract.allowedActions).not.toContain("delete_file");
      expect(contract.allowedActions).not.toContain("delete_folder");
      expect(contract.forbiddenActions).toContain("delete_file");
      expect(contract.forbiddenActions).toContain("delete_folder");
      expect(contract.targetPaths).toEqual([]);
    });

    it("5. Nonexistent named entity 'Delete OldDashboardManager.' does not invent authority or substitute near-matches", async () => {
      const message = "Delete OldDashboardManager.";
      const assessment = DestructiveSafetyEvaluator.evaluate(message, sampleRepoFiles);

      expect(assessment.isDestructive).toBe(true);
      expect(assessment.targetCertainty).toBe("NONEXISTENT");
      expect(assessment.requiresClarification).toBe(true);
      expect(assessment.groundedTargets).toEqual([]);

      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        sampleRepoFiles
      );
      expect(classification.requiresClarification).toBe(true);
    });

    it("6. Semantic retrieval results (legacy-cache.ts, archived-records.ts, legacy-schema.ts) do not become DELETE authority solely by similarity", () => {
      const message = "Delete the old stuff and clean everything up.";
      // Even if semantic retrieval finds these files because of words like 'old', 'legacy', 'clean'
      const assessment = DestructiveSafetyEvaluator.evaluate(message, sampleRepoFiles);

      expect(assessment.requiresClarification).toBe(true);
      expect(assessment.groundedTargets).not.toContain("lib/legacy-cache.ts");
      expect(assessment.groundedTargets).not.toContain("data/archived-records.ts");
      expect(assessment.groundedTargets).not.toContain("types/legacy-schema.ts");
    });
  });

  describe("2, 3, 4: Explicit, Unique Entity, and Ambiguous Duplicate Entities", () => {
    it("2. 'Delete src/components/LegacyWidget.tsx.' authorizes explicit path without clarification", async () => {
      const message = "Delete src/components/LegacyWidget.tsx.";
      const assessment = DestructiveSafetyEvaluator.evaluate(message, sampleRepoFiles);

      expect(assessment.isDestructive).toBe(true);
      expect(assessment.targetCertainty).toBe("EXPLICIT");
      expect(assessment.requiresClarification).toBe(false);
      expect(assessment.groundedTargets).toContain("src/components/LegacyWidget.tsx");

      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        sampleRepoFiles
      );
      expect(classification.requiresClarification).toBe(false);
      expect(classification.targetPath).toBe("src/components/LegacyWidget.tsx");

      const contract = buildExecutionContract(classification, message, sampleRepoFiles);
      expect(contract.targetPaths).toContain("src/components/LegacyWidget.tsx");
      expect(contract.allowedActions).toContain("delete_file");
    });

    it("3. 'Remove LegacyActivityWidget.' uniquely resolves to exact repository file without clarification", async () => {
      const message = "Remove LegacyActivityWidget.";
      const assessment = DestructiveSafetyEvaluator.evaluate(message, sampleRepoFiles);

      expect(assessment.isDestructive).toBe(true);
      expect(assessment.targetCertainty).toBe("GROUNDED_UNIQUE");
      expect(assessment.requiresClarification).toBe(false);
      expect(assessment.groundedTargets).toContain("src/components/activity/LegacyActivityWidget.tsx");

      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        sampleRepoFiles
      );
      expect(classification.requiresClarification).toBe(false);

      const contract = buildExecutionContract(classification, message, sampleRepoFiles);
      expect(contract.targetPaths).toContain("src/components/activity/LegacyActivityWidget.tsx");
      expect(contract.allowedActions).toContain("delete_file");
    });

    it("4. Ambiguous duplicate entities across different directories are not automatically authorized", async () => {
      const repoWithDuplicate = [
        "src/admin/LegacyWidget.tsx",
        "src/dashboard/LegacyWidget.tsx",
        "app/page.tsx",
      ];
      const message = "Delete LegacyWidget.";
      const assessment = DestructiveSafetyEvaluator.evaluate(message, repoWithDuplicate);

      expect(assessment.isDestructive).toBe(true);
      expect(assessment.targetCertainty).toBe("AMBIGUOUS");
      expect(assessment.requiresClarification).toBe(true);
      expect(assessment.clarificationQuestion).toMatch(/Multiple matching files were found for "LegacyWidget"/i);
      expect(assessment.groundedTargets).toEqual([]);

      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        repoWithDuplicate
      );
      expect(classification.requiresClarification).toBe(true);
    });
  });

  describe("7 & 8: In-file 'remove' Language Must Remain MODIFY Operations", () => {
    it("7. 'Remove the unused import from app/page.tsx.' is classified as MODIFY/BUG_FIX, NOT DELETE_FILE", async () => {
      const message = "Remove the unused import from app/page.tsx.";
      const assessment = DestructiveSafetyEvaluator.evaluate(message, sampleRepoFiles);

      expect(assessment.isDestructive).toBe(false);
      expect(assessment.isInFileModification).toBe(true);
      expect(assessment.requiresClarification).toBe(false);

      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        sampleRepoFiles
      );
      expect(classification.requiresClarification).toBe(false);
      expect(classification.taskType).not.toBe("DELETE_FILE");
      expect(classification.taskType).not.toBe("DELETE_FOLDER");
      expect(classification.targetPath).toBe("app/page.tsx");

      const contract = buildExecutionContract(classification, message, sampleRepoFiles);
      expect(contract.allowedActions).toContain("modify_file");
      expect(contract.allowedActions).not.toContain("delete_file");
      expect(contract.targetPaths).toContain("app/page.tsx");
    });

    it("8. 'Remove extra padding from the Card component.' is classified as MODIFY, NOT destructive file deletion", async () => {
      const message = "Remove extra padding from the Card component.";
      const assessment = DestructiveSafetyEvaluator.evaluate(message, sampleRepoFiles);

      expect(assessment.isDestructive).toBe(false);
      expect(assessment.isInFileModification).toBe(true);
      expect(assessment.requiresClarification).toBe(false);

      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        sampleRepoFiles
      );
      expect(classification.requiresClarification).toBe(false);
      expect(classification.taskType).not.toBe("DELETE_FILE");
      expect(classification.taskType).not.toBe("DELETE_FOLDER");
    });
  });

  describe("9 & 10: Compound Tasks with Destructive Components", () => {
    it("9. 'Remove the deprecated activity widget and clean every reference to it.' resolves unique entity without false clarification", async () => {
      const message = "Remove the deprecated activity widget and clean every reference to it.";

      const assessment = DestructiveSafetyEvaluator.evaluate(message, sampleRepoFiles);
      expect(assessment.isDestructive).toBe(true);
      expect(assessment.targetCertainty).toBe("GROUNDED_UNIQUE");
      expect(assessment.requiresClarification).toBe(false);
      expect(assessment.groundedTargets).toContain("src/components/activity/LegacyActivityWidget.tsx");

      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        sampleRepoFiles
      );
      expect(classification.requiresClarification).toBe(false);

      const contract = buildExecutionContract(classification, message, sampleRepoFiles);
      expect(contract.targetPaths).toContain("src/components/activity/LegacyActivityWidget.tsx");
      expect(contract.allowedActions).toContain("delete_file");
      expect(contract.allowedActions).toContain("remove_imports");
      expect(contract.allowedActions).toContain("update_references");
    });

    it("9b. 'Remove the deprecated activity widget.' with two matching activity widgets triggers clarification", async () => {
      const repoWithTwoWidgets = [
        "src/components/activity/LegacyActivityWidget.tsx",
        "src/components/activity/NewActivityWidget.tsx",
        "app/page.tsx",
      ];
      const message = "Remove the deprecated activity widget.";
      const assessment = DestructiveSafetyEvaluator.evaluate(message, repoWithTwoWidgets);

      expect(assessment.isDestructive).toBe(true);
      expect(assessment.targetCertainty).toBe("AMBIGUOUS");
      expect(assessment.requiresClarification).toBe(true);
      expect(assessment.clarificationQuestion).toMatch(/Multiple matching files were found for "activity widget"/i);

      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        repoWithTwoWidgets
      );
      expect(classification.requiresClarification).toBe(true);
    });

    it("9c. Negative case: 'Delete deprecated things.' fails closed with clarification", async () => {
      const message = "Delete deprecated things.";
      const assessment = DestructiveSafetyEvaluator.evaluate(message, sampleRepoFiles);

      expect(assessment.isDestructive).toBe(true);
      expect(assessment.targetCertainty).toBe("VAGUE");
      expect(assessment.requiresClarification).toBe(true);

      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        sampleRepoFiles
      );
      expect(classification.requiresClarification).toBe(true);
    });

    it("9d. Negative case: 'Remove deprecated dashboard code.' with multiple dashboard files triggers clarification", async () => {
      const repoWithManyDashboards = [
        "src/dashboard/page.tsx",
        "src/components/dashboard/header.tsx",
        "src/types/dashboard.ts",
      ];
      const message = "Remove deprecated dashboard code.";
      const assessment = DestructiveSafetyEvaluator.evaluate(message, repoWithManyDashboards);

      expect(assessment.isDestructive).toBe(true);
      expect(assessment.targetCertainty).toBe("AMBIGUOUS");
      expect(assessment.requiresClarification).toBe(true);

      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        repoWithManyDashboards
      );
      expect(classification.requiresClarification).toBe(true);
    });

    it("10. 'Replace the deprecated activity widget with a new RecentActivity panel and update the dashboard to use it.' remains valid DELETE + CREATE + MODIFY", async () => {
      const message = "Replace the deprecated activity widget with a new RecentActivity panel and update the dashboard to use it.";
      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        sampleRepoFiles
      );
      expect(classification.requiresClarification).toBe(false);

      const contract = buildExecutionContract(classification, message, sampleRepoFiles);
      expect(contract.targetPaths).toContain("src/components/activity/LegacyActivityWidget.tsx");
      expect(contract.allowedActions).toContain("delete_file");
      expect(contract.allowedActions).toContain("create_components");
      expect(contract.allowedActions).toContain("modify_file");
    });
  });

  describe("11 & 12: Cluster A Invariants Retained", () => {
    it("11. Explicit path hard-scope protections from Cluster A remain green", () => {
      const message = "Fix the error only in app/tasks/page.tsx.";
      const classification: TaskClassificationResult = {
        taskType: "BUG_FIX",
        intent: "BUG_FIX",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: "Hard scoped fix",
      };
      const contract = buildExecutionContract(classification, message, sampleRepoFiles);
      expect(contract.targetPaths).toEqual(["app/tasks/page.tsx"]);
      expect(contract.targetPaths).not.toContain("src/components/activity/LegacyActivityWidget.tsx");
    });

    it("12. HTTP route target tests from Cluster A remain green", () => {
      const message = "Add GET /health/details using the existing architecture.";
      const classification: TaskClassificationResult = {
        taskType: "NEW_FEATURE",
        intent: "NEW_FEATURE",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: "API endpoint",
      };
      const contract = buildExecutionContract(classification, message, sampleRepoFiles);
      expect(contract.targetPaths).not.toContain("health/details");
      expect(contract.targetPaths).not.toContain("/health/details");
    });
  });

  describe("Deterministic Reverse-Reference Cleanup Authority for Grounded Delete Targets", () => {
    const reverseRefRepoFiles = [
      "src/components/activity/LegacyActivityWidget.tsx",
      "src/components/activity/LegacyActivityWidget.css",
      "src/components/dashboard/DashboardOverview.tsx",
      "src/components/activity/ActivityFilter.tsx",
      "app/App.tsx",
    ];

    const reverseRefSnapshotFiles = [
      {
        path: "src/components/activity/LegacyActivityWidget.tsx",
        content: `
export function LegacyActivityWidget() {
  return <div className="activity-widget">Legacy Widget</div>;
}
`,
      },
      {
        path: "src/components/activity/LegacyActivityWidget.css",
        content: `.activity-widget { color: red; }`,
      },
      {
        path: "src/components/dashboard/DashboardOverview.tsx",
        content: `
import React from 'react';
import { LegacyActivityWidget } from '../activity/LegacyActivityWidget';

export function DashboardOverview() {
  return (
    <section>
      <h1>Dashboard Overview</h1>
      <LegacyActivityWidget />
    </section>
  );
}
`,
      },
      {
        path: "src/components/activity/ActivityFilter.tsx",
        content: `
import React from 'react';
export function ActivityFilter() {
  return <div>Filter Only</div>;
}
`,
      },
      {
        path: "app/App.tsx",
        content: `
import React from 'react';
import { DashboardOverview } from '../src/components/dashboard/DashboardOverview';

export function App() {
  return <DashboardOverview />;
}
`,
      },
    ];

    it("1 & 8: Grounded LegacyActivityWidget DELETE + DashboardOverview direct importer + 'clean every reference' authorizes DashboardOverview as supporting MODIFY and passes ManifestValidator", async () => {
      const message = "Remove the deprecated activity widget and clean every reference to it.";
      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        reverseRefRepoFiles
      );

      expect(classification.requiresClarification).toBe(false);

      const contract = buildExecutionContract(
        classification,
        message,
        reverseRefRepoFiles,
        { snapshotFiles: reverseRefSnapshotFiles }
      );

      // Primary delete targets have delete authority
      expect(contract.targetPaths).toContain("src/components/activity/LegacyActivityWidget.tsx");
      expect(contract.targetPaths).toContain("src/components/activity/LegacyActivityWidget.css");
      expect(contract.targetProvenance?.["src/components/activity/LegacyActivityWidget.tsx"]).toBe(
        "UNIQUE_NAMED_ENTITY"
      );

      // Direct importer receives supporting MODIFY authority with clear provenance
      expect(contract.targetPaths).toContain("src/components/dashboard/DashboardOverview.tsx");
      expect(contract.targetProvenance?.["src/components/dashboard/DashboardOverview.tsx"]).toBe(
        "DETERMINISTIC_REFERENCE_CLEANUP"
      );
      expect(contract.allowedActions).toContain("modify_file");
      expect(contract.allowedActions).toContain("delete_file");

      // Verify ManifestValidator validates the live evaluation manifest without path constraint violation
      const manifest: FileManifest = {
        manifestVersion: "1.0.0",
        totalFiles: 3,
        files: [
          {
            path: "src/components/activity/LegacyActivityWidget.tsx",
            action: "delete",
            description: "Remove legacy activity widget component",
            dependencies: [],
          },
          {
            path: "src/components/activity/LegacyActivityWidget.css",
            action: "delete",
            description: "Remove dedicated stylesheet",
            dependencies: [],
          },
          {
            path: "src/components/dashboard/DashboardOverview.tsx",
            action: "modify",
            description: "Clean references to deleted LegacyActivityWidget",
            dependencies: [],
          },
        ],
      };

      const validator = new ManifestValidator(contract, reverseRefRepoFiles);
      const validationResult = validator.validate(manifest);
      expect(validationResult.valid).toBe(true);
      expect(validationResult.errors).toEqual([]);
    });

    it("2: ActivityFilter is semantically related but not an importer -> strictly not authorized", async () => {
      const message = "Remove the deprecated activity widget and clean every reference to it.";
      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        reverseRefRepoFiles
      );

      const contract = buildExecutionContract(
        classification,
        message,
        reverseRefRepoFiles,
        { snapshotFiles: reverseRefSnapshotFiles }
      );

      expect(contract.targetPaths).not.toContain("src/components/activity/ActivityFilter.tsx");

      // Manifest proposing ActivityFilter must be rejected by ManifestValidator
      const invalidManifest: FileManifest = {
        manifestVersion: "1.0.0",
        totalFiles: 4,
        files: [
          {
            path: "src/components/activity/LegacyActivityWidget.tsx",
            action: "delete",
            description: "Remove legacy activity widget component",
            dependencies: [],
          },
          {
            path: "src/components/activity/LegacyActivityWidget.css",
            action: "delete",
            description: "Remove dedicated stylesheet",
            dependencies: [],
          },
          {
            path: "src/components/dashboard/DashboardOverview.tsx",
            action: "modify",
            description: "Clean references to deleted LegacyActivityWidget",
            dependencies: [],
          },
          {
            path: "src/components/activity/ActivityFilter.tsx",
            action: "modify",
            description: "Unrelated modification",
            dependencies: [],
          },
        ],
      };

      const validator = new ManifestValidator(contract, reverseRefRepoFiles);
      const res = validator.validate(invalidManifest);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.type === "path_constraint")).toBe(true);
    });

    it("3: App.tsx indirectly renders DashboardOverview -> not automatically authorized solely through transitive reachability", async () => {
      const message = "Remove the deprecated activity widget and clean every reference to it.";
      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        reverseRefRepoFiles
      );

      const contract = buildExecutionContract(
        classification,
        message,
        reverseRefRepoFiles,
        { snapshotFiles: reverseRefSnapshotFiles }
      );

      expect(contract.targetPaths).not.toContain("app/App.tsx");
    });

    it("4: Vague delete with no primary grounded target ('Delete the old stuff and clean everything up') yields clarification and zero cleanup authority", async () => {
      const message = "Delete the old stuff and clean everything up.";
      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        reverseRefRepoFiles
      );

      expect(classification.requiresClarification).toBe(true);

      const contract = buildExecutionContract(
        classification,
        message,
        reverseRefRepoFiles,
        { snapshotFiles: reverseRefSnapshotFiles }
      );

      expect(contract.targetPaths).toEqual([]);
      expect(contract.allowedActions).toEqual([]);
      expect(contract.targetPaths).not.toContain("src/components/dashboard/DashboardOverview.tsx");
    });

    it("5: Ambiguous activity widget yields clarification and zero cleanup authority", async () => {
      const repoWithTwo = [
        "src/components/activity/LegacyActivityWidget.tsx",
        "src/components/activity/NewActivityWidget.tsx",
        "src/components/dashboard/DashboardOverview.tsx",
      ];
      const message = "Remove the activity widget and clean every reference.";
      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        repoWithTwo
      );

      expect(classification.requiresClarification).toBe(true);

      const contract = buildExecutionContract(
        classification,
        message,
        repoWithTwo,
        { snapshotFiles: reverseRefSnapshotFiles }
      );

      expect(contract.targetPaths).not.toContain("src/components/dashboard/DashboardOverview.tsx");
      expect(contract.allowedActions).toEqual([]);
    });

    it("6: Explicit LegacyActivityWidget path + cleanup authorizes direct importer for MODIFY", async () => {
      const message = "Delete src/components/activity/LegacyActivityWidget.tsx and clean every reference to it.";
      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        reverseRefRepoFiles
      );

      expect(classification.requiresClarification).toBe(false);

      const contract = buildExecutionContract(
        classification,
        message,
        reverseRefRepoFiles,
        { snapshotFiles: reverseRefSnapshotFiles }
      );

      expect(contract.targetPaths).toContain("src/components/activity/LegacyActivityWidget.tsx");
      expect(contract.targetProvenance?.["src/components/activity/LegacyActivityWidget.tsx"]).toBe(
        "EXPLICIT_USER_PATH"
      );
      expect(contract.targetPaths).toContain("src/components/dashboard/DashboardOverview.tsx");
      expect(contract.targetProvenance?.["src/components/dashboard/DashboardOverview.tsx"]).toBe(
        "DETERMINISTIC_REFERENCE_CLEANUP"
      );
    });

    it("7: Unique LegacyActivityWidget name + cleanup authorizes direct importer for MODIFY", async () => {
      const message = "Remove LegacyActivityWidget and clean every reference to it.";
      const classification = await IntentClassifier.classifyIntentAndAmbiguity(
        message,
        {},
        reverseRefRepoFiles
      );

      expect(classification.requiresClarification).toBe(false);

      const contract = buildExecutionContract(
        classification,
        message,
        reverseRefRepoFiles,
        { snapshotFiles: reverseRefSnapshotFiles }
      );

      expect(contract.targetPaths).toContain("src/components/activity/LegacyActivityWidget.tsx");
      expect(contract.targetProvenance?.["src/components/activity/LegacyActivityWidget.tsx"]).toBe(
        "UNIQUE_NAMED_ENTITY"
      );
      expect(contract.targetPaths).toContain("src/components/dashboard/DashboardOverview.tsx");
      expect(contract.targetProvenance?.["src/components/dashboard/DashboardOverview.tsx"]).toBe(
        "DETERMINISTIC_REFERENCE_CLEANUP"
      );
    });
  });
});
