import {
  enforceExecutionScope,
  resolveEffectiveAction,
} from "../contracts/ExecutionScopeEnforcer";
import { AgentFileChange, ExecutionContract, FileManifest } from "../../types";

describe("ExecutionScopeEnforcer — Deterministic Execution Boundary Tests", () => {
  const baseContract: ExecutionContract = {
    goal: "Update feature",
    taskType: "BUG_FIX",
    risk: "LOW",
    estimatedComplexity: "SMALL",
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    targetPaths: ["src"],
    allowedActions: ["modify_existing_files"],
    forbiddenActions: [],
    maxFiles: 5,
    searchScope: ["src"],
    contextScope: ["src"],
    diffCriticEnabled: true,
  };

  test("TEST A: Approved modify passes", () => {
    const manifest: FileManifest = {
      files: [
        {
          path: "src/auth.ts",
          action: "modify",
          dependencies: [],
          description: "Update authentication logic",
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const existingFilePaths = ["src/auth.ts"];
    const proposedChanges: AgentFileChange[] = [
      {
        path: "src/auth.ts",
        content: "export const auth = true;",
        description: "Update auth",
        action: "modify",
      },
    ];

    const res = enforceExecutionScope({
      proposedChanges,
      manifest,
      contract: baseContract,
      existingFilePaths,
    });

    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("TEST B: Undeclared file rejects complete generation with UNDECLARED_FILE", () => {
    const manifest: FileManifest = {
      files: [
        {
          path: "src/auth.ts",
          action: "modify",
          dependencies: [],
          description: "Update authentication logic",
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const existingFilePaths = ["src/auth.ts", "package.json"];
    const proposedChanges: AgentFileChange[] = [
      {
        path: "src/auth.ts",
        content: "export const auth = true;",
        description: "Update auth",
        action: "modify",
      },
      {
        path: "package.json",
        content: '{"name": "test"}',
        description: "Update dependencies",
        action: "modify",
      },
    ];

    const res = enforceExecutionScope({
      proposedChanges,
      manifest,
      contract: baseContract,
      existingFilePaths,
    });

    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.reason === "UNDECLARED_FILE" && e.path === "package.json")).toBe(true);
  });

  test("TEST C: Action mismatch rejects with ACTION_MISMATCH", () => {
    const manifest: FileManifest = {
      files: [
        {
          path: "src/auth.ts",
          action: "modify",
          dependencies: [],
          description: "Update authentication",
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const existingFilePaths = ["src/auth.ts"];
    const proposedChanges: AgentFileChange[] = [
      {
        path: "src/auth.ts",
        content: "",
        description: "Delete auth file",
        action: "delete",
        isDeleted: true,
      },
    ];

    const res = enforceExecutionScope({
      proposedChanges,
      manifest,
      contract: baseContract,
      existingFilePaths,
    });

    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.reason === "ACTION_MISMATCH")).toBe(true);
  });

  test("TEST D: Create existing file fails with CREATE_FILE_ALREADY_EXISTS", () => {
    const manifest: FileManifest = {
      files: [
        {
          path: "src/auth.ts",
          action: "create",
          dependencies: [],
          description: "Create auth file",
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const existingFilePaths = ["src/auth.ts"];
    const proposedChanges: AgentFileChange[] = [
      {
        path: "src/auth.ts",
        content: "export const auth = true;",
        description: "Create auth",
        action: "create",
      },
    ];

    const res = enforceExecutionScope({
      proposedChanges,
      manifest,
      contract: baseContract,
      existingFilePaths,
    });

    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.reason === "CREATE_FILE_ALREADY_EXISTS")).toBe(true);
  });

  test("TEST E: Modify missing file fails with MODIFY_FILE_NOT_FOUND", () => {
    const manifest: FileManifest = {
      files: [
        {
          path: "src/missing.ts",
          action: "modify",
          dependencies: [],
          description: "Modify missing file",
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const existingFilePaths: string[] = [];
    const proposedChanges: AgentFileChange[] = [
      {
        path: "src/missing.ts",
        content: "export const missing = true;",
        description: "Modify missing",
        action: "modify",
      },
    ];

    const res = enforceExecutionScope({
      proposedChanges,
      manifest,
      contract: baseContract,
      existingFilePaths,
    });

    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.reason === "MODIFY_FILE_NOT_FOUND")).toBe(true);
  });

  test("TEST F: Delete missing file fails with DELETE_FILE_NOT_FOUND", () => {
    const manifest: FileManifest = {
      files: [
        {
          path: "src/missing.ts",
          action: "delete",
          dependencies: [],
          description: "Delete missing file",
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const existingFilePaths: string[] = [];
    const proposedChanges: AgentFileChange[] = [
      {
        path: "src/missing.ts",
        content: "",
        description: "Delete missing",
        action: "delete",
        isDeleted: true,
      },
    ];

    const res = enforceExecutionScope({
      proposedChanges,
      manifest,
      contract: baseContract,
      existingFilePaths,
    });

    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.reason === "DELETE_FILE_NOT_FOUND")).toBe(true);
  });

  test("TEST G: Correct delete passes", () => {
    const manifest: FileManifest = {
      files: [
        {
          path: "src/legacy.ts",
          action: "delete",
          dependencies: [],
          description: "Delete legacy file",
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const existingFilePaths = ["src/legacy.ts"];
    const proposedChanges: AgentFileChange[] = [
      {
        path: "src/legacy.ts",
        content: "",
        description: "Delete legacy",
        action: "delete",
        isDeleted: true,
      },
    ];

    const res = enforceExecutionScope({
      proposedChanges,
      manifest,
      contract: baseContract,
      existingFilePaths,
    });

    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("TEST H: Path normalization matches Windows and POSIX slashes", () => {
    const manifest: FileManifest = {
      files: [
        {
          path: "src/auth.ts",
          action: "modify",
          dependencies: [],
          description: "Update authentication",
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const existingFilePaths = ["src/auth.ts"];
    const proposedChanges: AgentFileChange[] = [
      {
        path: "src\\auth.ts", // Windows backslash
        content: "export const auth = true;",
        description: "Update auth",
        action: "modify",
      },
    ];

    const res = enforceExecutionScope({
      proposedChanges,
      manifest,
      contract: baseContract,
      existingFilePaths,
    });

    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("TEST I: maxFiles fails closed when exceeded without slicing", () => {
    const strictContract: ExecutionContract = {
      ...baseContract,
      maxFiles: 1,
    };

    const manifest: FileManifest = {
      files: [
        { path: "src/a.ts", action: "modify", dependencies: [], description: "a" },
        { path: "src/b.ts", action: "modify", dependencies: [], description: "b" },
      ],
      totalFiles: 2,
      manifestVersion: "1.0.0",
    };

    const existingFilePaths = ["src/a.ts", "src/b.ts"];
    const proposedChanges: AgentFileChange[] = [
      { path: "src/a.ts", content: "a", description: "a", action: "modify" },
      { path: "src/b.ts", content: "b", description: "b", action: "modify" },
    ];

    const res = enforceExecutionScope({
      proposedChanges,
      manifest,
      contract: strictContract,
      existingFilePaths,
    });

    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.reason === "MAX_FILES_EXCEEDED")).toBe(true);
  });

  test("TEST J: Broad task (NEW_FEATURE) is still strictly constrained by manifest", () => {
    const broadContract: ExecutionContract = {
      ...baseContract,
      taskType: "NEW_FEATURE",
      targetPaths: [],
      maxFiles: 10,
    };

    const manifest: FileManifest = {
      files: [
        {
          path: "src/feature.ts",
          action: "create",
          dependencies: [],
          description: "New feature",
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const existingFilePaths = ["package.json"];
    const proposedChanges: AgentFileChange[] = [
      {
        path: "src/feature.ts",
        content: "export const feature = 1;",
        description: "New feature",
        action: "create",
      },
      {
        path: "package.json",
        content: '{"name": "updated"}',
        description: "Unplanned package.json change",
        action: "modify",
      },
    ];

    const res = enforceExecutionScope({
      proposedChanges,
      manifest,
      contract: broadContract,
      existingFilePaths,
    });

    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.reason === "UNDECLARED_FILE" && e.path === "package.json")).toBe(true);
  });

  test("TEST K: Immutability — inputs are not mutated", () => {
    const manifest: FileManifest = {
      files: [{ path: "src/auth.ts", action: "modify", dependencies: [], description: "auth" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };
    const contract = { ...baseContract };
    const proposedChanges = [
      { path: "src/auth.ts", content: "x", description: "d", action: "modify" as const },
    ];
    const existingFilePaths = ["src/auth.ts"];

    const manifestCopy = JSON.stringify(manifest);
    const contractCopy = JSON.stringify(contract);
    const changesCopy = JSON.stringify(proposedChanges);
    const existingCopy = JSON.stringify(existingFilePaths);

    enforceExecutionScope({
      proposedChanges,
      manifest,
      contract,
      existingFilePaths,
    });

    expect(JSON.stringify(manifest)).toBe(manifestCopy);
    expect(JSON.stringify(contract)).toBe(contractCopy);
    expect(JSON.stringify(proposedChanges)).toBe(changesCopy);
    expect(JSON.stringify(existingFilePaths)).toBe(existingCopy);
  });

  test("TEST L: Action inference when change.action is omitted", () => {
    const existsAction = resolveEffectiveAction({ path: "src/exist.ts", content: "c", description: "d" }, true);
    const notExistsAction = resolveEffectiveAction({ path: "src/new.ts", content: "c", description: "d" }, false);
    const explicitDelete = resolveEffectiveAction({ path: "src/del.ts", content: "", description: "d", isDeleted: true }, true);

    expect(existsAction).toBe("modify");
    expect(notExistsAction).toBe("create");
    expect(explicitDelete).toBe("delete");
  });
});
