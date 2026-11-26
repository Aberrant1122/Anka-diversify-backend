import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import path from "path";
import { WorkspaceService } from "./workspace-service";
import { ExecutionPolicy } from "./document-executor";
import {
  WorkspaceArtifacts,
  ImplementationArtifact,
} from "./workspace-artifacts";
import {
  DockerSandbox,
  SandboxAdapter,
  PlannedCommand,
  validateSandboxRequest,
  CommandResult,
} from "./sandbox";
import {
  GitBranchPublisher,
  PublicationAdapter,
  PublicationTarget,
  githubRemote,
  PublicationReceipt,
} from "./publication";
import { Unit, hash, WorkspaceError } from "./document-contract";
export class WorkspaceExecutionService {
  private artifacts: WorkspaceArtifacts;
  private publisher: PublicationAdapter;
  constructor(
    private db: PrismaClient,
    private service: WorkspaceService,
    private policy: ExecutionPolicy,
    private sandbox: SandboxAdapter = new DockerSandbox(),
    publisher?: PublicationAdapter,
  ) {
    this.artifacts = new WorkspaceArtifacts(policy);
    this.publisher = publisher || new GitBranchPublisher(db, policy.runsRoot);
  }
  async capabilities(projectId: string, actor: string) {
    await this.service.view(projectId, actor);
    return {
      isolatedValidation: await this.sandbox.ready(),
      publication: this.publisher.available(),
      runtimeAcceptanceVerified: false,
    };
  }
  private plan(authority: any): PlannedCommand[] {
    return (authority.units as Unit[]).flatMap((unit) =>
      (unit.commands || []).map((command) => ({
        ...command,
        unitId: unit.id,
        repositoryId: unit.repositoryId,
      })),
    );
  }
  async validate(
    projectId: string,
    actor: string,
    runId: string,
    input: {
      expectedVersion: number;
      idempotencyKey: string;
      expectedChangeHash: string;
    },
  ) {
    const run = await this.service.assertRunnable(projectId, actor, runId),
      plan = this.plan(run.authority);
    if (!plan.length)
      throw new WorkspaceError("VERIFICATION_COMMANDS_REQUIRED", 422);
    validateSandboxRequest({
      protocol: 1,
      nonce: randomUUID(),
      inputHash: "0".repeat(64),
      commands: plan,
    });
    if (!(await this.sandbox.ready()))
      throw new WorkspaceError("ISOLATED_RUNTIME_UNAVAILABLE", 503);
    const { operation, reused } = await this.service.beginRunOperation(
      projectId,
      actor,
      runId,
      { ...input, kind: "VALIDATION" },
    );
    if (reused) return operation;
    try {
      const context = operation.context as any,
        implementation = context.implementation as ImplementationArtifact;
      const outcomes = [],
        inputs = [],
        results: CommandResult[] = [];
      for (const repositoryId of [
        ...new Set(plan.map((c) => c.repositoryId)),
      ]) {
        const snapshot = await this.artifacts.snapshot(
            runId,
            implementation,
            repositoryId,
          ),
          commands = plan.filter((c) => c.repositoryId === repositoryId);
        const result = await this.sandbox.run(snapshot.directory, {
          protocol: 1,
          nonce: operation.id,
          inputHash: snapshot.inputHash,
          commands,
        });
        if (
          result.inputHash !== snapshot.inputHash ||
          result.commandsHash !== hash(commands) ||
          result.results.length !== commands.length ||
          result.results.some(
            (r, i) =>
              r.id !== commands[i].id ||
              r.unitId !== commands[i].unitId ||
              r.criterionId !== commands[i].criterionId,
          )
        )
          throw new WorkspaceError("SANDBOX_RESULT_INVALID");
        outcomes.push(result);
        results.push(...result.results);
        inputs.push({
          repositoryId,
          inputHash: snapshot.inputHash,
          fileCount: snapshot.files.length,
          excludedCount: snapshot.excluded.length,
          imageId: result.imageId,
          runtime: result.runtime,
        });
      }
      await this.artifacts.inspect(runId, implementation);
      const ordered = plan.map(
        (c) => results.find((r) => r.unitId === c.unitId && r.id === c.id)!,
      );
      return await this.service.finishRunOperation(
        projectId,
        actor,
        operation.id,
        {
          changeHash: implementation.changeHash,
          commandsHash: hash(plan),
          results: ordered,
          inputs,
          passed:
            ordered.length === plan.length &&
            ordered.every((r) => r.exitCode === 0 && !r.timedOut),
          evidenceClass: outcomes.some(
            (o) => o.evidenceClass === "CONTRACT_TEST",
          )
            ? "CONTRACT_TEST"
            : "DYNAMIC_ISOLATED_COMMAND_CHECKS",
        },
      );
    } catch (e) {
      await this.service.failRunOperation(
        projectId,
        actor,
        operation.id,
        e instanceof WorkspaceError ? e.code : "ISOLATED_RUNTIME_FAILED",
      );
      throw e;
    }
  }
  async preparePublication(
    projectId: string,
    actor: string,
    runId: string,
    input: {
      expectedVersion: number;
      idempotencyKey: string;
      expectedChangeHash: string;
    },
  ) {
    const { operation, reused } = await this.service.beginRunOperation(
      projectId,
      actor,
      runId,
      { ...input, kind: "PUBLICATION_PREPARE" },
    );
    if (reused) return operation;
    try {
      const context = operation.context as any,
        artifact = context.implementation as ImplementationArtifact;
      const repositories = await this.db.projectRepository.findMany({
        where: { projectId, project: { userId: actor } },
        select: { id: true, githubUrl: true, defaultBranch: true },
      });
      for (const binding of artifact.bindings) {
        const repo = repositories.find((r) => r.id === binding.repositoryId);
        if (!repo) throw new WorkspaceError("PUBLICATION_TARGET_CHANGED");
        githubRemote(repo.githubUrl);
      }
      const candidates = await this.artifacts.commit(runId, artifact);
      if (!candidates.length)
        throw new WorkspaceError("NO_PUBLICATION_CHANGES");
      const targets: PublicationTarget[] = candidates.map((candidate) => {
        const repo = repositories.find((r) => r.id === candidate.repositoryId)!;
        return {
          ...candidate,
          remote: githubRemote(repo.githubUrl),
          defaultBranch: repo.defaultBranch,
          branch: "anka/document-" + runId + "-" + hash(repo.id).slice(0, 12),
        };
      });
      const bundle = {
        runId,
        approvalId: context.authority.approvalId,
        mainId: context.authority.mainId,
        architectureId: context.authority.architectureId,
        changeHash: artifact.changeHash,
        diffHash: hash(artifact.diffs),
        targets,
      };
      return await this.service.finishRunOperation(
        projectId,
        actor,
        operation.id,
        { ...bundle, bundleHash: hash(bundle) },
      );
    } catch (e) {
      await this.service.failRunOperation(
        projectId,
        actor,
        operation.id,
        e instanceof WorkspaceError ? e.code : "PUBLICATION_PREPARATION_FAILED",
      );
      throw e;
    }
  }
  async publish(
    projectId: string,
    actor: string,
    runId: string,
    input: {
      expectedVersion: number;
      idempotencyKey: string;
      expectedChangeHash: string;
      publicationApprovalId: string;
    },
  ) {
    await this.service.assertRunnable(projectId, actor, runId);
    if (!this.publisher.available())
      throw new WorkspaceError("PUBLICATION_DISABLED", 503);
    const { operation, reused } = await this.service.beginRunOperation(
      projectId,
      actor,
      runId,
      { ...input, kind: "PUBLICATION" },
    );
    if (reused) return operation;
    try {
      const context = operation.context as any,
        bundle = context.preparation.payload.result,
        artifact = context.implementation as ImplementationArtifact;
      const candidates = await this.artifacts.commit(runId, artifact),
        roots = await this.artifacts.inspect(runId, artifact);
      if (
        bundle.targets.some(
          (t: PublicationTarget) =>
            candidates.find((c) => c.repositoryId === t.repositoryId)?.head !==
            t.head,
        )
      )
        throw new WorkspaceError("REVIEW_HEAD_MISMATCH");
      const receipts: PublicationReceipt[] = [];
      let uncertainRepositoryId: string | null = null;
      for (const target of bundle.targets as PublicationTarget[]) {
        try {
          receipts.push(
            await this.publisher.publish(
              projectId,
              actor,
              roots.get(target.repositoryId)!,
              target,
            ),
          );
        } catch {
          uncertainRepositoryId = target.repositoryId;
          break;
        }
      }
      return await this.service.finishRunOperation(
        projectId,
        actor,
        operation.id,
        {
          bundleHash: bundle.bundleHash,
          receipts,
          uncertainRepositoryId,
          complete: receipts.length === bundle.targets.length,
          evidenceClass: this.publisher.evidenceClass,
        },
      );
    } catch (e) {
      await this.service.failRunOperation(
        projectId,
        actor,
        operation.id,
        "PUBLICATION_OUTCOME_UNCERTAIN",
      );
      throw e;
    }
  }
  async reconcilePublication(
    projectId: string,
    actor: string,
    runId: string,
    preparedEventId: string,
  ) {
    const view = await this.service.view(projectId, actor),
      run = view.runs.find((r) => r.id === runId);
    if (!run) throw new WorkspaceError("RUN_NOT_FOUND", 404);
    if (!this.publisher.available())
      throw new WorkspaceError("PUBLICATION_DISABLED", 503);
    const prepared = run.events.find(
        (e) => e.id === preparedEventId && e.kind === "PUBLICATION_PREPARED",
      ),
      bundle = (prepared?.payload as any)?.result;
    if (!bundle) throw new WorkspaceError("PUBLICATION_PREPARATION_REQUIRED");
    const refs = [];
    for (const target of bundle.targets as PublicationTarget[]) {
      const head = await this.publisher.lookup(projectId, actor, target);
      refs.push({
        repositoryId: target.repositoryId,
        branch: target.branch,
        expectedHead: target.head,
        observedHead: head,
        matches: head === target.head,
      });
    }
    // Reconciliation records observations; it never issues a second push or
    // erases an uncertain/partial attempt, and never silently repairs a ref.
    return this.service.record(
      projectId,
      actor,
      runId,
      "PUBLICATION_RECONCILED",
      {
        bundleHash: bundle.bundleHash,
        refs,
        complete: refs.every((r) => r.matches),
        evidenceClass: this.publisher.evidenceClass,
      },
    );
  }
  async recover(
    projectId: string,
    actor: string,
    runId: string,
    operationId: string,
  ) {
    await this.service.view(projectId, actor);
    const operation = await this.db.workspaceOperation.findFirst({
      where: { id: operationId, projectId, runId, status: "RUNNING" },
    });
    if (
      !operation ||
      !["VALIDATION", "PUBLICATION_PREPARE", "PUBLICATION"].includes(
        operation.kind,
      )
    )
      throw new WorkspaceError("OPERATION_NOT_RUNNING");
    if (Date.now() - operation.createdAt.getTime() < 5 * 60 * 1000)
      throw new WorkspaceError("OPERATION_LEASE_ACTIVE");
    if (operation.kind === "VALIDATION") {
      if (!this.sandbox.cleanup)
        throw new WorkspaceError("ISOLATED_RECOVERY_UNAVAILABLE", 503);
      await this.sandbox.cleanup(operation.id);
    }
    return this.service.failRunOperation(
      projectId,
      actor,
      operation.id,
      "INTERRUPTED_OPERATION",
    );
  }
}
