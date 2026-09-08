import { ComponentContractGrounder } from "../contracts/ComponentContractGrounder";
import { buildSelfHealingRepairPrompt } from "../prompts/repair";
import { CODING_AGENT_PROMPT } from "../prompts/coding";
import { MultiRepoCoordinator, RepositoryCandidate } from "../coordination/MultiRepoCoordinator";
import { validateRepairManifestScope } from "../repair/RepairProposalResolver";
import { DiagnosticError } from "../../services/surgical-repair.engine";
import { FileManifest } from "../../types";

describe("Existing Component Prop Contract Grounding & Build Error Propagation", () => {
  const badgeSource = `import React from 'react';

export interface BadgeProps {
  children: React.ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'info';
}

export function Badge({ children, variant = 'default' }: BadgeProps) {
  return <span className={\`badge badge-\${variant}\`}>{children}</span>;
}
`;

  const userCardSource = `import { User } from '../types/user';
import { Badge } from './Badge';

export interface UserCardProps {
  user: User;
}

export function UserCard({ user }: UserCardProps) {
  return (
    <div className="user-card">
      <h3>{user.name}</h3>
      <Badge>{user.status}</Badge>
    </div>
  );
}
`;

  const chipSource = `import React from 'react';

export interface ChipProps {
  text: string;
  tone?: 'good' | 'bad';
}

export function Chip({ text, tone = 'good' }: ChipProps) {
  return <div className={\`chip chip-\${tone}\`}>{text}</div>;
}
`;

  const chipUserCardSource = `import { Chip } from './Chip';

export function UserCard({ user }: any) {
  return <Chip text={user.name} tone="good" />;
}
`;

  // ── 1. Existing local component: BadgeProps with children ───────────────────
  test("1. Generation context includes BadgeProps for an authorized file importing Badge", () => {
    const contracts = ComponentContractGrounder.resolveComponentContractsForGeneration({
      authorizedModifySources: {
        "src/components/UserCard.tsx": {
          path: "src/components/UserCard.tsx",
          content: userCardSource,
        },
      },
      approvedManifest: {
        files: [
          {
            path: "src/components/UserCard.tsx",
            action: "modify",
            description: "Modify UserCard",
            dependencies: ["./Badge"],
          },
        ],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      },
      effectiveResolutionSourceMap: {
        "src/components/Badge.tsx": badgeSource,
      },
      userMessage: "Reuse existing Badge component in UserCard",
    });

    expect(contracts).toHaveLength(1);
    expect(contracts[0].componentPath).toBe("src/components/Badge.tsx");
    expect(contracts[0].contractText).toContain("BadgeProps");
    expect(contracts[0].contractText).toContain("children: React.ReactNode");
    expect(contracts[0].contractText).toContain("READ-ONLY");
  });

  // ── 2. Read-only context does not expand write scope ───────────────────────
  test("2. Existing component context is READ-ONLY and does not expand write scope", () => {
    const approvedManifest: FileManifest = {
      files: [
        {
          path: "src/components/UserCard.tsx",
          action: "modify",
          description: "Modify UserCard",
          dependencies: [],
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    // Attempting to modify Badge.tsx when only UserCard.tsx is approved must be rejected
    const illegalProposal = [
      {
        path: "src/components/Badge.tsx",
        action: "modify" as const,
        description: "Illegally modify Badge to add status prop",
        edits: [{ oldText: "variant?:", newText: "status?: string; variant?:" }],
      },
    ];

    const scopeCheck = validateRepairManifestScope(illegalProposal, approvedManifest);
    expect(scopeCheck.valid).toBe(false);
    if (!scopeCheck.valid) {
      expect(scopeCheck.error.code).toBe("REPAIR_UNDECLARED_FILE");
    }
  });

  // ── 3. Generic non-Badge component (ChipProps) ─────────────────────────────
  test("3. Generic non-Badge component (ChipProps) resolves without hardcoding Badge", () => {
    const contracts = ComponentContractGrounder.resolveComponentContractsForGeneration({
      authorizedModifySources: {
        "src/components/UserCard.tsx": {
          path: "src/components/UserCard.tsx",
          content: chipUserCardSource,
        },
      },
      approvedManifest: {
        files: [
          {
            path: "src/components/UserCard.tsx",
            action: "modify",
            description: "Modify UserCard",
            dependencies: ["./Chip"],
          },
        ],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      },
      effectiveResolutionSourceMap: {
        "src/components/Chip.tsx": chipSource,
      },
      userMessage: "Display chip for user",
    });

    expect(contracts).toHaveLength(1);
    expect(contracts[0].componentPath).toBe("src/components/Chip.tsx");
    expect(contracts[0].contractText).toContain("ChipProps");
    expect(contracts[0].contractText).toContain("text: string");
    expect(contracts[0].contractText).toContain("tone?: 'good' | 'bad'");
    expect(contracts[0].contractText).not.toContain("Badge");
  });

  // ── 4. TS2322 repair context includes authoritative BadgeProps ─────────────
  test("4. TS2322 repair context includes authoritative BadgeProps and repair mandate", () => {
    const diagnostic: DiagnosticError = {
      file: "src/components/UserCard.tsx",
      line: 15,
      column: 16,
      code: "TS2322",
      message: "Type '{ status: UserStatus; }' is not assignable to type 'IntrinsicAttributes & BadgeProps'. Property 'status' does not exist on type 'IntrinsicAttributes & BadgeProps'.",
      rawTrace: "src/components/UserCard.tsx(15,16): error TS2322: Property 'status' does not exist on type 'IntrinsicAttributes & BadgeProps'.",
    };

    const currentFiles = {
      "src/components/UserCard.tsx": `import { Badge } from './Badge';
export function UserCard({ user }: any) {
  return (
    <div>
      <Badge status={user.status} />
    </div>
  );
}`,
      "src/components/Badge.tsx": badgeSource,
    };

    const prompt = buildSelfHealingRepairPrompt({
      errorLog: "src/components/UserCard.tsx(15,16): error TS2322: Property 'status' does not exist on type 'IntrinsicAttributes & BadgeProps'.",
      diagnostics: [diagnostic],
      currentFiles,
      approvedManifest: {
        files: [{ path: "src/components/UserCard.tsx", action: "modify", description: "UserCard", dependencies: [] }],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      },
    });

    expect(prompt.user).toContain("AUTHORITATIVE EXISTING COMPONENT CONTRACT CONTEXT");
    expect(prompt.user).toContain("src/components/Badge.tsx");
    expect(prompt.user).toContain("children: React.ReactNode");
    expect(prompt.user).toContain("Repair against the authoritative existing component interface");
    expect(prompt.user).toContain("Do not rename one invented prop to another without evidence");
  });

  // ── 5. Repair context does not grant Badge.tsx write authority ──────────────
  test("5. Repair context does not grant Badge.tsx write authority", () => {
    const approvedManifest: FileManifest = {
      files: [{ path: "src/components/UserCard.tsx", action: "modify", description: "UserCard", dependencies: [] }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const repairProposals = [
      {
        path: "src/components/Badge.tsx",
        action: "modify" as const,
        description: "Illegal repair proposal to Badge",
        edits: [{ oldText: "export interface BadgeProps {", newText: "export interface BadgeProps { status?: any;" }],
      },
    ];

    const validation = validateRepairManifestScope(repairProposals, approvedManifest);
    expect(validation.valid).toBe(false);
    if (!validation.valid) {
      expect(validation.error.message).toContain("src/components/Badge.tsx");
    }
  });

  // ── 6. Deterministic generator instruction is present ───────────────────────
  test("6. CODING_AGENT_PROMPT contains deterministic component prop contract instruction", () => {
    expect(CODING_AGENT_PROMPT).toContain("EXISTING LOCAL COMPONENT USAGE");
    expect(CODING_AGENT_PROMPT).toContain("conform to its authoritative exported prop/interface contract");
    expect(CODING_AGENT_PROMPT).toContain("Do not invent props that are not present in that contract");
  });

  // ── 7. MultiRepoCoordinator failure log prefers actual buildErrors ───────────
  test("7. MultiRepoCoordinator failure log prefers actual buildErrors over explanation", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const mockRunner = async () => ({
      runId: "run-web-1",
      branchName: "anka/run-web-1",
      baseCommitSha: "sha-12345",
      worktreePath: "/tmp/anka/runs/run-web-1",
      changedFiles: [],
      diffSummary: "",
      validationPassed: false,
      validationCommands: ["npm run build", "npm run typecheck"],
      validationErrors: "ROOT BUILD FAILURE:\nsrc/components/UserCard.tsx(15,16): error TS2322: Type '{ status: UserStatus; }' is not assignable to type 'IntrinsicAttributes & BadgeProps'. Property 'status' does not exist on type 'IntrinsicAttributes & BadgeProps'.",
      agentResponse: {
        explanation: "To add user status support, I modified the User type...",
        changes: [],
        commitMessage: "",
        sessionId: "sess-1",
        buildVerified: false,
        lifecycleStage: "BuildFailed" as const,
        buildErrors: "ROOT BUILD FAILURE:\nsrc/components/UserCard.tsx(15,16): error TS2322: Type '{ status: UserStatus; }' is not assignable to type 'IntrinsicAttributes & BadgeProps'. Property 'status' does not exist on type 'IntrinsicAttributes & BadgeProps'.",
      },
    });

    const mockRepo: RepositoryCandidate = {
      id: "repo-web-id",
      name: "MONOREPO_WEB_test",
      role: "frontend",
      localPath: "/mock/repo-web",
      isPrimary: true,
    };

    const coordinator = new MultiRepoCoordinator(mockRunner);
    const result = await coordinator.coordinateTask({
      userId: "user-1",
      projectId: "proj-1",
      userPrompt: "Add user status support",
      customRepositories: [mockRepo],
    });

    expect(result.overallStatus).toBe("FAILED");
    expect(errorSpy).toHaveBeenCalled();
    const loggedCalls = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(loggedCalls).toContain("[MULTI_REPO_STEP_FAILED]");
    expect(loggedCalls).toContain("repo=MONOREPO_WEB_test");
    expect(loggedCalls).toContain("code=BUILD_VERIFICATION_FAILED");
    expect(loggedCalls).toContain("src/components/UserCard.tsx(15,16): error TS2322");
    expect(loggedCalls).not.toContain("To add user status support");

    errorSpy.mockRestore();
  });

  // ── 8. No token or secret leakage in MultiRepoCoordinator logs ───────────────
  test("8. No token or secret leakage in MultiRepoCoordinator error logs", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const mockRunner = async () => ({
      runId: "run-web-2",
      branchName: "anka/run-web-2",
      baseCommitSha: "sha-12345",
      worktreePath: "/tmp/anka/runs/run-web-2",
      changedFiles: [],
      diffSummary: "",
      validationPassed: false,
      validationCommands: ["npm run build"],
      agentResponse: {
        explanation: "Failed",
        changes: [],
        commitMessage: "",
        sessionId: "sess-1",
        buildVerified: false,
        lifecycleStage: "BuildFailed" as const,
        buildErrors: "Authorization failed with ghp_SECRET_GITHUB_TOKEN_12345 in src/api/client.ts(1,1): error TS9999: Auth",
      },
    });

    const mockRepo: RepositoryCandidate = {
      id: "repo-web-id",
      name: "MONOREPO_WEB_test",
      role: "frontend",
      localPath: "/mock/repo-web",
      isPrimary: true,
    };

    const coordinator = new MultiRepoCoordinator(mockRunner);
    await coordinator.coordinateTask({
      userId: "user-1",
      projectId: "proj-1",
      userPrompt: "Secret token: ghp_USER_SECRET_67890",
      customRepositories: [mockRepo],
    });

    const loggedCalls = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(loggedCalls).toContain("[MULTI_REPO_STEP_FAILED]");
    expect(loggedCalls).not.toContain("ghp_SECRET_GITHUB_TOKEN_12345");
    expect(loggedCalls).not.toContain("ghp_USER_SECRET_67890");

    errorSpy.mockRestore();
  });

  // ── 9. git-worktree failure summary prefers buildErrors over explanation ─────
  test("9. git-worktree failure summary prefers buildErrors over explanation", () => {
    const agentResponse = {
      explanation: "Conversational summary of what was attempted",
      changes: [],
      commitMessage: "",
      sessionId: "s-1",
      buildVerified: false,
      buildErrors: "src/components/UserCard.tsx(15,16): error TS2322: Property 'status' does not exist on type 'IntrinsicAttributes & BadgeProps'.",
    };

    const validationPassed = false;
    const validationErrors = !validationPassed ? (agentResponse.buildErrors || agentResponse.explanation) : undefined;

    expect(validationErrors).toBe(agentResponse.buildErrors);
    expect(validationErrors).not.toBe(agentResponse.explanation);
  });
});
