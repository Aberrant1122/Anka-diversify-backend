import { PrismaClient } from "@prisma/client";
import { WorkspaceService } from "../workspace-service";
import {
  BaselineValidationService,
  BaselineEvidenceStore,
  AdmissionReceipt,
  ExecutionReceipt,
} from "../baseline-validation-service";
import { mainFromBrief, hash } from "../document-contract";
import { randomUUID } from "crypto";
export async function baselineDocuments(
  db: PrismaClient,
  project: string,
  actor: string,
) {
  const workspace = new WorkspaceService(db),
    baseline = new BaselineValidationService(db);
  const repo = await db.projectRepository.create({
    data: {
      projectId: project,
      name: "Synthetic baseline",
      role: "backend",
      githubUrl: "https://github.com/example/reference",
      currentIndexedCommit: "a".repeat(40),
    },
  });
  const m = mainFromBrief("Validate only an exact synthetic source criterion");
  m.questions = [];
  const main = await workspace.save(project, actor, {
    kind: "MAIN",
    content: m,
    expectedVersion: 0,
    reason: "Synthetic baseline test",
  });
  const limits = {
      totalTimeoutMs: 30000,
      memoryMiB: 512,
      workMiB: 256,
      tmpMiB: 64,
      stdoutBytes: 65536,
      stderrBytes: 65536,
    },
    budget = { measurementHash: "b".repeat(64), limits };
  const content: any = {
    schemaVersion: 2,
    sourceMain: { id: main.id, hash: main.contentHash },
    overview: "Read-only contract",
    components: [{ id: "COMP-ONE", description: "Read only" }],
    dataMigrations: [],
    interfaces: [],
    security: ["No network"],
    operations: ["No publication"],
    repositories: [{ id: repo.id, baseline: "a".repeat(40) }],
    units: [],
    questions: [],
    validationProfiles: [
      {
        id: "VAL-ONE",
        title: "Synthetic test",
        requirementIds: ["REQ-001"],
        criterionIds: ["AC-001"],
        repositoryId: repo.id,
        baseline: "a".repeat(40),
        runtimeProfileHash: "c".repeat(64),
        budgetProfile: { ...budget, hash: hash(budget) },
        commands: [
          {
            id: "CMD-ONE",
            criterionId: "AC-001",
            argv: ["node", "--test", "fixture.js"],
            cwd: ".",
            timeoutMs: 30000,
          },
        ],
      },
    ],
  };
  const architecture = await workspace.save(project, actor, {
    kind: "ARCHITECTURE",
    content,
    expectedVersion: 1,
    reason: "Synthetic profile",
  });
  const selection = {
    mainId: main.id,
    mainHash: main.contentHash,
    architectureId: architecture.id,
    architectureHash: architecture.contentHash,
    selectedProfileIds: ["VAL-ONE"],
  };
  const preview = await baseline.preview(project, actor, selection);
  const approvalInput = {
    ...selection,
    expectedVersion: 2,
    idempotencyKey: "approve-baseline-001",
    expectedBindingHash: preview.bindingHash,
    expectedPlanHash: preview.planHash,
  };
  const approval = await baseline.approve(project, actor, approvalInput);
  const runInput = {
    approvalId: approval.id,
    expectedVersion: 3,
    idempotencyKey: "authorize-baseline-001",
    expectedBindingHash: preview.bindingHash,
    expectedPlanHash: preview.planHash,
    retryOfOperationId: null,
  };
  const run = await baseline.authorize(project, actor, runInput);
  const claimInput = {
    runId: run.id,
    expectedVersion: 4,
    idempotencyKey: "claim-baseline-001",
    expectedBindingHash: preview.bindingHash,
    expectedPlanHash: preview.planHash,
  };
  return {
    workspace,
    baseline,
    repo,
    main,
    architecture,
    content,
    selection,
    preview,
    approvalInput,
    approval,
    runInput,
    run,
    claimInput,
    project,
    actor,
  };
}
export async function baselineFixture(db: PrismaClient) {
  const id = randomUUID();
  const actor = "owner-" + id;
  await db.user.create({
    data: { id: actor, email: actor + "@example.test", password: "synthetic" },
  });
  const project = await db.project.create({
    data: { name: "Synthetic V2 fixture", userId: actor },
  });
  return baselineDocuments(db, project.id, actor);
}
export function contractStore(): BaselineEvidenceStore {
  const admission = (op: any): AdmissionReceipt => ({
    operationId: op.id,
    jobId: op.jobId,
    bindingHash: op.authority.bindingHash,
    planHash: op.authority.planHash,
    evidenceClass: "CONTRACT_TEST",
    imageDigest: "sha256:" + "d".repeat(64),
    runtime: "runsc",
    profiles: op.authority.binding.profiles.map((p: any) => ({
      profileId: p.id,
      runtimeProfileHash: p.runtimeProfileHash,
      budgetProfileHash: p.budgetProfile.hash,
      measurementHash: p.budgetProfile.measurementHash,
      acceptedRecordId: "synthetic-only",
      runtimeAcceptanceVerified: false,
      measurementAcceptanceVerified: false,
    })),
  });
  return {
    admission: async (op, id) =>
      id === "contract-start" ? admission(op) : null,
    execution: async (op, id) =>
      id === "contract-result"
        ? ({
            ...admission(op),
            results: (op.authority as any).plan.commands.map((c: any) => ({
              profileId: c.profileId,
              repositoryId: c.repositoryId,
              id: c.id,
              criterionId: c.criterionId,
              exitCode: 0,
              timedOut: false,
              outputLimitExceeded: false,
            })),
          } as ExecutionReceipt)
        : null,
    cleanup: async (op, id) =>
      id === "contract-cleanup"
        ? { operationId: op.id, jobId: op.jobId, confirmed: true, recordId: id }
        : null,
  };
}
