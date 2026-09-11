import { TargetPathExtractor } from "../contracts/TargetPathExtractor";
import { buildExecutionContract } from "../contracts/ExecutionContractBuilder";
import { TaskClassificationResult } from "../shared/types";

describe("Target Authority and HTTP Route Grounding (Cluster A Fix)", () => {
  const baseClassification: TaskClassificationResult = {
    intent: "NEW_FEATURE",
    reasoning: "test",
    taskType: "NEW_FEATURE",
    risk: "LOW",
    estimatedComplexity: "SMALL",
    confidence: 0.95,
    requiresClarification: false,
  };

  const sampleRepoFiles = [
    "app/tasks/page.tsx",
    "components/tasks/task-filter.tsx",
    "src/routes/health.routes.ts",
    "src/controllers/health.controller.ts",
    "src/services/health.service.ts",
    "src/routes/user.routes.ts",
    "src/controllers/user.controller.ts",
    "src/services/user.service.ts",
    "src/controllers/customer.controller.ts",
    "src/routes/team.routes.ts",
    "src/services/team.service.ts",
  ];

  describe("Part A & M: HTTP Route Detection vs Filesystem Targets", () => {
    it("1. HTTP route '/health/details' is not a filesystem target", () => {
      const message = "Add the /health/details endpoint to monitor system status";
      const targets = TargetPathExtractor.extract(message, { repoFiles: sampleRepoFiles });
      expect(targets).not.toContain("health/details");
      expect(targets).not.toContain("/health/details");
    });

    it("2. 'GET /health/details' is not a filesystem target", () => {
      const message = "Add a GET /health/details endpoint using the existing route, controller, and service architecture.";
      const targets = TargetPathExtractor.extract(message, { repoFiles: sampleRepoFiles });
      expect(targets).not.toContain("health/details");
      expect(targets).not.toContain("/health/details");
      expect(targets).not.toContain("GET /health/details");
    });

    it("3. explicit 'src/routes/health.routes.ts' remains a filesystem target even when prompt mentions HTTP routes", () => {
      const message = "Update src/routes/health.routes.ts to add GET /health/details.";
      const targets = TargetPathExtractor.extract(message, { repoFiles: sampleRepoFiles });
      expect(targets).toContain("src/routes/health.routes.ts");
      expect(targets).not.toContain("health/details");
      expect(targets).not.toContain("/health/details");
    });

    it("identifies parameterized HTTP routes (e.g. /users/:id/activate) as route identifiers, not paths", () => {
      expect(TargetPathExtractor.isHttpRouteIdentifier("/users/:id", "GET /users/:id")).toBe(true);
      expect(TargetPathExtractor.isHttpRouteIdentifier("users/:id/activate", "POST /users/:id/activate")).toBe(true);
      expect(TargetPathExtractor.isHttpRouteIdentifier("src/services/user.service.ts", "modify src/services/user.service.ts")).toBe(false);
    });
  });

  describe("Part C: Deterministic Entity Normalization", () => {
    it("4. TaskFilter normalizes across PascalCase, camelCase, kebab-case, snake_case, spaces to the same comparison key", () => {
      const k1 = TargetPathExtractor.normalizeEntityKey("TaskFilter");
      const k2 = TargetPathExtractor.normalizeEntityKey("taskFilter");
      const k3 = TargetPathExtractor.normalizeEntityKey("task-filter");
      const k4 = TargetPathExtractor.normalizeEntityKey("task_filter");
      const k5 = TargetPathExtractor.normalizeEntityKey("task filter");

      expect(k1).toBe("taskfilter");
      expect(k2).toBe("taskfilter");
      expect(k3).toBe("taskfilter");
      expect(k4).toBe("taskfilter");
      expect(k5).toBe("taskfilter");
    });

    it("normalizes ProjectCard across naming styles", () => {
      const p1 = TargetPathExtractor.normalizeEntityKey("ProjectCard");
      const p2 = TargetPathExtractor.normalizeEntityKey("project-card");
      const p3 = TargetPathExtractor.normalizeEntityKey("project_card");
      const p4 = TargetPathExtractor.normalizeEntityKey("project card");

      expect(p1).toBe("projectcard");
      expect(p2).toBe("projectcard");
      expect(p3).toBe("projectcard");
      expect(p4).toBe("projectcard");
    });
  });

  describe("Part D, K, Q, R: Unique Entity Promotion and Ambiguity Rejection", () => {
    it("5. unique named component may be promoted into authority (Case A1 TaskFilter)", () => {
      const message = "Fix the TaskFilter component error on the tasks page.";
      const contract = buildExecutionContract(
        { ...baseClassification, taskType: "BUG_FIX" },
        message,
        sampleRepoFiles
      );

      expect(contract.targetPaths).toContain("components/tasks/task-filter.tsx");
      expect(contract.targetProvenance?.["components/tasks/task-filter.tsx"]).toBe("UNIQUE_NAMED_ENTITY");
    });

    it("6. ambiguous same-name components are not both authorized", () => {
      const repoWithAmbiguity = [
        "components/admin/TaskFilter.tsx",
        "components/tasks/TaskFilter.tsx",
        "app/tasks/page.tsx",
      ];
      const message = "Fix TaskFilter.";
      const grounded = TargetPathExtractor.extractGroundedEntities(message, repoWithAmbiguity);

      // Ambiguous match must NOT authorize either file automatically
      expect(grounded).toEqual([]);
    });

    it("7. nonexistent named component does not create authority", () => {
      const message = "Fix SuperTaskFilter.";
      const grounded = TargetPathExtractor.extractGroundedEntities(message, sampleRepoFiles);
      expect(grounded).toEqual([]);

      const contract = buildExecutionContract(
        { ...baseClassification, taskType: "BUG_FIX" },
        message,
        sampleRepoFiles
      );
      expect(contract.targetPaths).not.toContain("SuperTaskFilter");
      expect(contract.targetPaths.filter((p) => p.includes("SuperTaskFilter"))).toHaveLength(0);
    });

    it("8. semantic search result alone does not create authority", () => {
      // In TaskPathExtractor, only explicitly extracted and grounded entities gain authority.
      // Arbitrary unmentioned files returned by semantic retrieval (e.g. ProjectCard, DashboardOverview) are not in contract
      const message = "Fix the TaskFilter component";
      const contract = buildExecutionContract(
        { ...baseClassification, taskType: "BUG_FIX" },
        message,
        sampleRepoFiles
      );
      expect(contract.targetPaths).toContain("components/tasks/task-filter.tsx");
      expect(contract.targetPaths).not.toContain("src/routes/health.routes.ts");
      expect(contract.targetPaths).not.toContain("src/services/user.service.ts");
    });
  });

  describe("Part H, I, O: Layered API Architecture Authority Expansion", () => {
    it("9. architecture wording alone does not grant layered service/controller/route authority", () => {
      const message = "Add a service method for retrieving active users and expose it through the existing API architecture.";
      const contract = buildExecutionContract(
        { ...baseClassification, taskType: "NEW_FEATURE" },
        message,
        sampleRepoFiles
      );

      expect(contract.targetPaths).toEqual([]);
      expect(contract.targetProvenance?.["src/services/user.service.ts"]).toBeUndefined();
      expect(contract.targetProvenance?.["src/controllers/user.controller.ts"]).toBeUndefined();
      expect(contract.targetProvenance?.["src/routes/user.routes.ts"]).toBeUndefined();
    });

    it("10. unrelated route/controller/service files are not authorized", () => {
      const message = "Add a service method for retrieving active users and expose it through the existing API architecture.";
      const contract = buildExecutionContract(
        { ...baseClassification, taskType: "NEW_FEATURE" },
        message,
        sampleRepoFiles
      );

      expect(contract.targetPaths).not.toContain("src/controllers/customer.controller.ts");
      expect(contract.targetPaths).not.toContain("src/routes/team.routes.ts");
      expect(contract.targetPaths).not.toContain("src/services/team.service.ts");
      expect(contract.targetPaths).not.toContain("src/routes/health.routes.ts");
      expect(contract.targetPaths).not.toContain("src/controllers/health.controller.ts");
    });

    it("does not turn GET /health/details text into file authority or malformed paths", () => {
      const message = "Add a GET /health/details endpoint using the existing route, controller, and service architecture.";
      const contract = buildExecutionContract(
        { ...baseClassification, taskType: "NEW_FEATURE" },
        message,
        sampleRepoFiles
      );

      expect(contract.targetPaths).not.toContain("health/details");
      expect(contract.targetPaths).not.toContain("/health/details");
      expect(contract.targetPaths).toEqual([]);
      expect(contract.targetProvenance?.["src/routes/health.routes.ts"]).toBeUndefined();
      expect(contract.targetProvenance?.["src/controllers/health.controller.ts"]).toBeUndefined();
      expect(contract.targetProvenance?.["src/services/health.service.ts"]).toBeUndefined();
    });
  });

  describe("Part L: Explicit File Hard Scope Preservation", () => {
    it("12. explicit user path remains hard-scoped when user says 'only in'", () => {
      const message = "Fix the error only in app/tasks/page.tsx.";
      const contract = buildExecutionContract(
        { ...baseClassification, taskType: "BUG_FIX" },
        message,
        sampleRepoFiles
      );

      expect(contract.targetPaths).toEqual(["app/tasks/page.tsx"]);
      expect(contract.targetPaths).not.toContain("components/tasks/task-filter.tsx");
    });
  });
});
