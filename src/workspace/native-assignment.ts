import { Prisma, PrismaClient } from "@prisma/client";

import { hash, parseMain, parseArchitecture, safePath, WorkspaceError } from "./document-contract";
import { HandoffPreviewService, HandoffPreviewInput } from "./handoff-preview";

type Tx = Prisma.TransactionClient;
type FileScope = { repositoryId: string; path: string; action: string };
export type NativeAssignmentContext = {
  packet: Awaited<ReturnType<HandoffPreviewService["preview"]>>;
  files: FileScope[];
  sessionReference: string;
  authorizationNote: string;
  authorizedBy: string;
  authorizationKind: "OWNER_EXPLICIT_SCOPE_CONFIRMATION";
  providerDispatchAuthorized: false;
};
export interface NativeReceipt {
  criterionId: string; repositoryId: string; baseline: string;
  commit: string | null; testedCommit: string | null;
  status: "PASSED" | "FAILED" | "NOT_RUN";
  check: { command: string[]; exitCode: number | null; stdout: string; stderr: string };
  evidenceLabel: "OWNER_REPORTED" | "DISPOSABLE_SAMPLE";
}
const fail = (code: string, status = 409): never => { throw new WorkspaceError(code, status); };
function object(raw: unknown, keys: string[]): Record<string, any> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("NATIVE_INPUT_INVALID", 422);
  const v = raw as Record<string, any>;
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(k => !keys.includes(k))) return fail("NATIVE_INPUT_INVALID", 422);
  return v;
}
function text(v: unknown, max: number): string {
  if (typeof v !== "string" || !v.trim() || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) return fail("NATIVE_INPUT_INVALID", 422);
  return v;
}
function version(v: unknown): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0) return fail("NATIVE_INPUT_INVALID", 422);
  return v as number;
}
function key(v: unknown): string {
  const s = text(v, 100);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(s)) return fail("NATIVE_INPUT_INVALID", 422);
  return s;
}
const digest = (v: unknown) => typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v);
const previewKeys = ["expectedStateVersion", "mainId", "mainHash", "architectureId", "architectureHash", "requirementIds", "criterionIds"];

/** An immutable manual-work ledger. Never launches providers, Git or shell. */
export class NativeAssignmentService {
  constructor(private readonly db: PrismaClient) {}
  private async tx<T>(projectId: string, actor: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    if (!actor) return fail("AUTHENTICATION_REQUIRED", 401);
    try {
      return await this.db.$transaction(async tx => {
        if (!await tx.project.findFirst({ where: { id: projectId, userId: actor, user: { status: "active" } }, select: { id: true } })) return fail("PROJECT_RESOURCE_NOT_FOUND", 404);
        return work(tx);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 });
    } catch (e) {
      if (["P2034", "P2002"].includes((e as {code?:string})?.code || "")) return fail("STATE_CONFLICT");
      throw e;
    }
  }
  private async head(tx: Tx, projectId: string) {
    const head = await tx.workspaceHead.findUnique({ where: { projectId } });
    if (!head) return fail("DRAFT_DOCUMENTS_REQUIRED", 422);
    return head;
  }
  private async current(tx: Tx, projectId: string, context: NativeAssignmentContext) {
    const head = await tx.workspaceHead.findUnique({ where: { projectId } });
    if (!head || head.mainId !== context.packet.documents.main.id || head.architectureId !== context.packet.documents.architecture.id) return false;
    const docs = await tx.workspaceDocument.findMany({ where: { projectId, id: { in: [head.mainId!, head.architectureId!] } }, select: { id: true, contentHash: true, sourceMainId: true } });
    if (!docs.some(d => d.id === head.mainId && d.contentHash === context.packet.documents.main.hash) || !docs.some(d => d.id === head.architectureId && d.contentHash === context.packet.documents.architecture.hash && d.sourceMainId === head.mainId)) return false;
    const repositories = await tx.projectRepository.findMany({ where: { projectId, id: { in: context.packet.repositoryBinding.repositories.map(r => r.id) } }, select: { id: true } });
    return repositories.length === context.packet.repositoryBinding.repositories.length;
  }
  private async advance(tx: Tx, projectId: string, expected: number) {
    const changed = await tx.workspaceHead.updateMany({ where: { projectId, stateVersion: expected }, data: { stateVersion: { increment: 1 } } });
    if (changed.count !== 1) return fail("STATE_CONFLICT");
  }
  private async existing(tx: Tx, projectId: string, kind: string, idempotencyKey: string, inputHash: string) {
    const prior = await tx.workspaceOperation.findUnique({ where: { projectId_kind_idempotencyKey: { projectId, kind, idempotencyKey } } });
    if (prior && prior.inputHash !== inputHash) return fail("NATIVE_IDEMPOTENCY_CONFLICT");
    return prior;
  }
  private async assignment(tx: Tx, projectId: string, id: string) {
    const row = await tx.workspaceOperation.findFirst({ where: { id, projectId, kind: "NATIVE_ASSIGNMENT" } });
    if (!row) return fail("PROJECT_RESOURCE_NOT_FOUND", 404);
    return row;
  }
  private async record(tx: Tx, projectId: string, actor: string, kind: string, idempotencyKey: string, inputHash: string, stateVersion: number, context: unknown) {
    const row = await tx.workspaceOperation.create({ data: { projectId, kind, idempotencyKey, inputHash, stateVersion, context: context as Prisma.InputJsonValue, createdBy: actor, status: "COMPLETED", completedAt: new Date() } });
    await tx.workspaceEvent.create({ data: { projectId, kind: kind + "_RECORDED", createdBy: actor, payload: { recordId: row.id } } });
    await this.advance(tx, projectId, stateVersion);
    return row;
  }
  async create(projectId: string, actor: string, raw: unknown) {
    const v = object(raw, [...previewKeys, "packetHash", "idempotencyKey", "sessionReference", "authorizationNote", "acknowledgeAuthorization", "files"]);
    const idempotencyKey = key(v.idempotencyKey), sessionReference = text(v.sessionReference, 200), authorizationNote = text(v.authorizationNote, 2000);
    version(v.expectedStateVersion);
    if (v.acknowledgeAuthorization !== true || typeof v.packetHash !== "string" || !/^[a-f0-9]{64}$/.test(v.packetHash)) return fail("NATIVE_AUTHORIZATION_REQUIRED", 422);
    if (!Array.isArray(v.files) || !v.files.length || v.files.length > 100) return fail("NATIVE_SCOPE_INVALID", 422);
    const files: FileScope[] = v.files.map((raw: unknown) => { const f = object(raw, ["repositoryId", "path", "action"]); return { repositoryId: text(f.repositoryId, 200), path: safePath(f.path), action: text(f.action, 10) }; });
    if (new Set(files.map(f => f.repositoryId + ":" + f.path.toLowerCase())).size !== files.length) return fail("NATIVE_SCOPE_INVALID", 422);
    const inputHash = hash(v);
    // Exact retries resolve even after a successful mutation advanced the head.
    const prior = await this.tx(projectId, actor, tx => this.existing(tx, projectId, "NATIVE_ASSIGNMENT", idempotencyKey, inputHash));
    if (prior) return this.recovery(projectId, actor, prior.id);
    const selection = Object.fromEntries(previewKeys.map(k => [k, v[k]])) as unknown as HandoffPreviewInput;
    const packet = await new HandoffPreviewService(this.db).preview(projectId, actor, selection);
    if (packet.packetHash !== v.packetHash) return fail("HANDOFF_STALE");
    if (packet.repositoryBinding.status !== "BOUND") return fail("NATIVE_BASELINE_REQUIRED", 422);
    return this.tx(projectId, actor, async tx => {
      const replay = await this.existing(tx, projectId, "NATIVE_ASSIGNMENT", idempotencyKey, inputHash);
      if (replay) return this.project(tx, projectId, replay);
      const head = await this.head(tx, projectId);
      if (head.stateVersion !== v.expectedStateVersion || head.mainId !== packet.documents.main.id || head.architectureId !== packet.documents.architecture.id) return fail("HANDOFF_STALE");
      const doc = await tx.workspaceDocument.findFirst({ where: { id: head.architectureId!, projectId } }), main = await tx.workspaceDocument.findFirst({ where: { id: head.mainId!, projectId } });
      if (!doc || !main || (doc.content as any)?.schemaVersion !== 1) return fail("NATIVE_IMPLEMENTATION_PURPOSE_REQUIRED", 422);
      const arch = parseArchitecture(doc.content, parseMain(main.content));
      const units = arch.units.filter(u => u.requirementIds.some(id => v.requirementIds.includes(id)) && u.checks.some(c => v.criterionIds.includes(c.criterionId)));
      for (const f of files) if (!packet.repositoryBinding.repositories.some(r => r.id === f.repositoryId) || !units.some(u => u.repositoryId === f.repositoryId && u.files.some(a => a.path === f.path && a.action === f.action))) return fail("NATIVE_SCOPE_INVALID", 422);
      for (const criterionId of v.criterionIds) if (!units.some(u => u.checks.some(c => c.criterionId === criterionId) && files.some(f => f.repositoryId === u.repositoryId && u.files.some(a => a.path === f.path && a.action === f.action)))) return fail("NATIVE_SCOPE_INVALID", 422);
      const scopedRepos = await tx.projectRepository.findMany({ where: { projectId, id: { in: packet.repositoryBinding.repositories.map(r => r.id) } }, select: { id: true } });
      if (scopedRepos.length !== packet.repositoryBinding.repositories.length) return fail("PROJECT_RESOURCE_NOT_FOUND", 404);
      const records = await tx.workspaceOperation.findMany({ where: { projectId, kind: "NATIVE_ASSIGNMENT" } });
      for (const row of records) {
        const c = row.context as unknown as NativeAssignmentContext;
        if (c.packet.documents.main.id === head.mainId && c.packet.documents.architecture.id === head.architectureId && (c.packet.verificationExpectations.some(x => v.criterionIds.includes(x.criterionId)) || c.files.some(a => files.some(b => a.repositoryId === b.repositoryId && a.path.toLowerCase() === b.path.toLowerCase())))) return fail("NATIVE_SCOPE_ALREADY_ASSIGNED");
      }
      const context: NativeAssignmentContext = { packet, files: files.sort((a,b) => (a.repositoryId + a.path).localeCompare(b.repositoryId + b.path)), sessionReference, authorizationNote, authorizedBy: actor, authorizationKind: "OWNER_EXPLICIT_SCOPE_CONFIRMATION", providerDispatchAuthorized: false };
      const row = await this.record(tx, projectId, actor, "NATIVE_ASSIGNMENT", idempotencyKey, inputHash, head.stateVersion, context);
      return this.project(tx, projectId, row);
    });
  }
  private async project(tx: Tx, projectId: string, row: any) {
    const context = row.context as NativeAssignmentContext;
    const evidenceRows = await tx.workspaceOperation.findMany({ where: { projectId, kind: "NATIVE_EVIDENCE" }, orderBy: { stateVersion: "asc" } });
    const evidence = evidenceRows.filter(r => (r.context as any).assignmentId === row.id).map(r => ({ id: r.id, createdAt: r.createdAt, reportedBy: r.createdBy, evidenceClass: "OWNER_REPORTED_NOT_INDEPENDENTLY_VERIFIED" as const, receipt: (r.context as any).receipt as NativeReceipt }));
    const observations = await tx.workspaceOperation.findMany({ where: { projectId, kind: "NATIVE_RECOVERY" }, orderBy: { stateVersion: "asc" } });
    const criteria = context.packet.verificationExpectations.map(c => { const receipts = evidence.filter(e => e.receipt.criterionId === c.criterionId); return { ...c, status: receipts.length ? receipts[receipts.length - 1].receipt.status : "MISSING" as const }; });
    const authorityCurrent = await this.current(tx, projectId, context);
    const commits = [...new Set(evidence.map(e => e.receipt.commit).filter(Boolean))];
    return { id: row.id, createdAt: row.createdAt, createdBy: row.createdBy, context, authorityCurrent, evidence, criteria, reportedCommits: commits, independentVerification: "NOT_PERFORMED" as const, accepted: false as const,
      recoveryObservations: observations.filter(r => (r.context as any).assignmentId === row.id).map(r => ({ id: r.id, recordedBy: r.createdBy, ...((r.context as any).observation), measurementClass: "OWNER_REPORTED" as const })),
      nextDecision: !authorityCurrent ? "Documents changed. Stop work and obtain a new bounded authorization." : criteria.some(c => c.status === "MISSING" || c.status === "NOT_RUN") ? "Return missing criterion evidence; no success is inferred." : criteria.some(c => c.status === "FAILED") ? "Review failed criterion evidence before deciding repair scope." : commits.length !== 1 ? "Receipts identify different commits. Review evidence for one exact implementation before acceptance." : "Review owner-reported receipts. Independent verification and founder acceptance remain pending." };
  }
  async list(projectId: string, actor: string) {
    return this.tx(projectId, actor, async tx => { const rows = await tx.workspaceOperation.findMany({ where: { projectId, kind: "NATIVE_ASSIGNMENT" }, orderBy: { stateVersion: "asc" } }); return Promise.all(rows.map(row => this.project(tx, projectId, row))); });
  }
  async recovery(projectId: string, actor: string, id: string) {
    return this.tx(projectId, actor, async tx => this.project(tx, projectId, await this.assignment(tx, projectId, id)));
  }
  async evidence(projectId: string, actor: string, id: string, raw: unknown) {
    const v = object(raw, ["expectedStateVersion", "idempotencyKey", "receipt"]), expected = version(v.expectedStateVersion), idempotencyKey = key(v.idempotencyKey);
    const receipt = object(v.receipt, ["criterionId", "repositoryId", "baseline", "commit", "testedCommit", "status", "check", "evidenceLabel"]);
    text(receipt.criterionId, 200); text(receipt.repositoryId, 200);
    if (!digest(receipt.baseline) || !["PASSED", "FAILED", "NOT_RUN"].includes(receipt.status) || !["OWNER_REPORTED", "DISPOSABLE_SAMPLE"].includes(receipt.evidenceLabel)) return fail("NATIVE_EVIDENCE_INVALID", 422);
    const check = object(receipt.check, ["command", "exitCode", "stdout", "stderr"]);
    if (!Array.isArray(check.command) || check.command.length > 32 || check.command.some((x: unknown) => typeof x !== "string" || !x || x.length > 1000) || typeof check.stdout !== "string" || check.stdout.length > 8000 || typeof check.stderr !== "string" || check.stderr.length > 8000) return fail("NATIVE_EVIDENCE_INVALID", 422);
    if (receipt.status === "NOT_RUN") {
      if (receipt.commit !== null || receipt.testedCommit !== null || check.exitCode !== null) return fail("NATIVE_EVIDENCE_INVALID", 422);
    } else if (!digest(receipt.commit) || receipt.testedCommit !== receipt.commit || !check.command.length || !Number.isInteger(check.exitCode) || check.exitCode < -1 || check.exitCode > 255 || (receipt.status === "PASSED" ? check.exitCode !== 0 : check.exitCode === 0)) return fail("NATIVE_EVIDENCE_COMMIT_OR_RESULT_MISMATCH", 422);
    const inputHash = hash({ assignmentId: id, ...v });
    return this.tx(projectId, actor, async tx => {
      const assignment = await this.assignment(tx, projectId, id), replay = await this.existing(tx, projectId, "NATIVE_EVIDENCE", idempotencyKey, inputHash);
      if (replay) return this.project(tx, projectId, assignment);
      const context = assignment.context as unknown as NativeAssignmentContext, head = await this.head(tx, projectId);
      if (!await this.current(tx, projectId, context)) return fail("HANDOFF_STALE");
      if (head.stateVersion !== expected) return fail("STATE_CONFLICT");
      const selected = context.packet.verificationExpectations.find(c => c.criterionId === receipt.criterionId);
      const repo = context.packet.repositoryBinding.repositories.find(r => r.id === receipt.repositoryId && r.baseline === receipt.baseline);
      if (!selected || !repo || !context.files.some(f => f.repositoryId === repo.id)) return fail("NATIVE_EVIDENCE_SCOPE_MISMATCH", 422);
      // Repository membership alone is insufficient when an assignment spans repositories.
      const main = await tx.workspaceDocument.findFirst({ where: { id: context.packet.documents.main.id, projectId } }), arch = await tx.workspaceDocument.findFirst({ where: { id: context.packet.documents.architecture.id, projectId } });
      const architecture = parseArchitecture(arch?.content, parseMain(main?.content));
      if (!architecture.units.some(u => u.repositoryId === repo.id && u.requirementIds.includes(selected.requirementId) && u.checks.some(c => c.criterionId === receipt.criterionId) && u.files.some(f => context.files.some(a => a.repositoryId === repo.id && a.path === f.path)))) return fail("NATIVE_EVIDENCE_SCOPE_MISMATCH", 422);
      const prior = await tx.workspaceOperation.findMany({ where: { projectId, kind: "NATIVE_EVIDENCE" } });
      const same = prior.find(r => (r.context as any).assignmentId === id && (r.context as any).receipt.criterionId === receipt.criterionId && (r.context as any).receipt.commit === receipt.commit);
      if (same) {
        if (hash((same.context as any).receipt) !== hash(receipt)) return fail("NATIVE_EVIDENCE_CONFLICT");
        return this.project(tx, projectId, assignment);
      }
      await this.record(tx, projectId, actor, "NATIVE_EVIDENCE", idempotencyKey, inputHash, expected, { assignmentId: id, receipt });
      return this.project(tx, projectId, assignment);
    });
  }
  async observeRecovery(projectId: string, actor: string, id: string, raw: unknown) {
    const v = object(raw, ["expectedStateVersion", "idempotencyKey", "sessionReference", "repeatedContextCount", "acknowledgeOwnerReported"]);
    const expected = version(v.expectedStateVersion), idempotencyKey = key(v.idempotencyKey), sessionReference = text(v.sessionReference, 200);
    if (!Number.isSafeInteger(v.repeatedContextCount) || v.repeatedContextCount < 0 || v.repeatedContextCount > 10000 || v.acknowledgeOwnerReported !== true) return fail("NATIVE_RECOVERY_OBSERVATION_INVALID", 422);
    const inputHash = hash({ assignmentId: id, ...v });
    return this.tx(projectId, actor, async tx => {
      const assignment = await this.assignment(tx, projectId, id), prior = await this.existing(tx, projectId, "NATIVE_RECOVERY", idempotencyKey, inputHash);
      if (prior) return this.project(tx, projectId, assignment);
      const head = await this.head(tx, projectId); if (head.stateVersion !== expected) return fail("STATE_CONFLICT");
      await this.record(tx, projectId, actor, "NATIVE_RECOVERY", idempotencyKey, inputHash, expected, { assignmentId: id, observation: { sessionReference, repeatedContextCount: v.repeatedContextCount, authorityCurrentAtObservation: await this.current(tx, projectId, assignment.context as unknown as NativeAssignmentContext) } });
      return this.project(tx, projectId, assignment);
    });
  }
}


