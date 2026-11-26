import { Prisma, PrismaClient } from "@prisma/client";
import { hash, parseMain, parseArchitectureDraft, WorkspaceError } from "./document-contract";

export interface HandoffPreviewInput {
  expectedStateVersion: number;
  mainId: string;
  mainHash: string;
  architectureId: string;
  architectureHash: string;
  requirementIds: string[];
  criterionIds: string[];
}
function input(raw: unknown): HandoffPreviewInput {
  const fail = (): never => { throw new WorkspaceError("HANDOFF_SELECTION_INVALID", 422); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const v = raw as Record<string, unknown>;
  const keys = ["expectedStateVersion", "mainId", "mainHash", "architectureId", "architectureHash", "requirementIds", "criterionIds"];
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(k => !keys.includes(k))) return fail();
  if (!Number.isSafeInteger(v.expectedStateVersion) || (v.expectedStateVersion as number) < 0) return fail();
  for (const key of ["mainId", "architectureId"]) if (typeof v[key] !== "string" || !(v[key] as string).length || (v[key] as string).length > 200) return fail();
  for (const key of ["mainHash", "architectureHash"]) if (typeof v[key] !== "string" || !/^[a-f0-9]{64}$/.test(v[key] as string)) return fail();
  for (const [key, prefix] of [["requirementIds", "REQ-"], ["criterionIds", "AC-"]]) {
    const ids = v[key];
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== "string" || id.length > 200 || !id.startsWith(prefix) || !/^[A-Z][A-Z0-9-]*$/.test(id)) || new Set(ids).size !== ids.length) return fail();
  }
  return v as unknown as HandoffPreviewInput;
}

/** Read-only business operation. In particular, never call WorkspaceService.view/head. */
export class HandoffPreviewService {
  constructor(private readonly db: PrismaClient) {}
  async preview(projectId: string, actor: string, raw: unknown) {
    if (!actor) throw new WorkspaceError("AUTHENTICATION_REQUIRED", 401);
    const request = input(raw);
    try {
      return await this.db.$transaction(async tx => {
        const project = await tx.project.findFirst({ where: { id: projectId, userId: actor }, select: { id: true, userId: true } });
        if (!project) throw new WorkspaceError("PROJECT_RESOURCE_NOT_FOUND", 404);
        const head = await tx.workspaceHead.findUnique({ where: { projectId }, select: { stateVersion: true, mainId: true, architectureId: true } });
        if (!head?.mainId || !head.architectureId) throw new WorkspaceError("DRAFT_DOCUMENTS_REQUIRED", 422);
        if (head.stateVersion !== request.expectedStateVersion || head.mainId !== request.mainId || head.architectureId !== request.architectureId) throw new WorkspaceError("HANDOFF_STALE");
        const main = await tx.workspaceDocument.findFirst({ where: { id: head.mainId, projectId, kind: "MAIN" }, select: { id: true, contentHash: true, content: true } });
        const architecture = await tx.workspaceDocument.findFirst({ where: { id: head.architectureId, projectId, kind: "ARCHITECTURE" }, select: { id: true, contentHash: true, content: true, sourceMainId: true } });
        if (!main || !architecture) throw new WorkspaceError("DRAFT_DOCUMENTS_REQUIRED", 422);
        if (main.contentHash !== request.mainHash || architecture.contentHash !== request.architectureHash) throw new WorkspaceError("HANDOFF_STALE");
        const m = parseMain(main.content), a = parseArchitectureDraft(architecture.content, m);
        if (hash(m) !== main.contentHash || hash(a) !== architecture.contentHash) throw new WorkspaceError("DOCUMENT_INTEGRITY_MISMATCH");
        if (architecture.sourceMainId !== main.id || a.sourceMain.id !== main.id || a.sourceMain.hash !== main.contentHash) throw new WorkspaceError("MAIN_VERSION_MISMATCH");
        const requirementIds = new Set(request.requirementIds), criterionIds = new Set(request.criterionIds);
        const selected = m.requirements.filter(r => requirementIds.has(r.id)).sort((a,b) => a.id.localeCompare(b.id));
        if (selected.length !== requirementIds.size) throw new WorkspaceError("HANDOFF_SELECTION_INVALID", 422);
        const knownCriteria = new Set(selected.flatMap(r => r.acceptanceCriteria.map(c => c.id)));
        if ([...criterionIds].some(id => !knownCriteria.has(id)) || selected.some(r => !r.acceptanceCriteria.some(c => criterionIds.has(c.id)))) throw new WorkspaceError("HANDOFF_SELECTION_INVALID", 422);
        const requirements = selected.map(r => ({ id: r.id, description: r.description, acceptanceCriteria: r.acceptanceCriteria.filter(c => criterionIds.has(c.id)).sort((a,b) => a.id.localeCompare(b.id)) }));
        // A declared repository alone does not establish applicability. Bind only
        // through selected criteria on implementation units or validation profiles.
        const applicableRepositories = new Set<string>(), mappedCriteria = new Set<string>();
        const scopes = a.schemaVersion === 2
          ? a.validationProfiles.map(p => ({repositoryId:p.repositoryId,requirementIds:p.requirementIds,criterionIds:p.criterionIds}))
          : a.units.map(u => ({repositoryId:u.repositoryId,requirementIds:u.requirementIds,criterionIds:[...u.checks.map(c=>c.criterionId),...(u.commands||[]).map(c=>c.criterionId)]}));
        for (const scope of scopes) {
          const covered = requirements.filter(r=>scope.requirementIds.includes(r.id)).flatMap(r=>r.acceptanceCriteria).filter(c=>scope.criterionIds.includes(c.id));
          if (covered.length) {
            applicableRepositories.add(scope.repositoryId);
            covered.forEach(c=>mappedCriteria.add(c.id));
          }
        }
        const bindings = a.repositories.filter(r=>applicableRepositories.has(r.id)).sort((a,b) => a.id.localeCompare(b.id));
        const unboundCriterionIds = [...criterionIds].filter(id=>!mappedCriteria.has(id)).sort();
        if (bindings.length) {
          const scoped = await tx.projectRepository.findMany({ where: { projectId, id: { in: bindings.map(r => r.id) } }, select: { id: true } });
          if (scoped.length !== bindings.length) throw new WorkspaceError("PROJECT_RESOURCE_NOT_FOUND", 404);
        }
        // Deliberate field allowlist: no project tokens/paths, raw legacy imports,
        // provider conversations, architecture overview/units or unselected criteria.
        const packet = {
          schemaVersion: 1 as const,
          purpose: "DRAFT_PREVIEW" as const,
          executionAuthorized: false as const,
          projectId: project.id,
          ownerReference: project.userId,
          stateVersion: head.stateVersion,
          freshness: "VERSION_BOUND_SNAPSHOT" as const,
          documents: { main: { id: main.id, hash: main.contentHash }, architecture: { id: architecture.id, hash: architecture.contentHash, sourceMain: { id: a.sourceMain.id, hash: a.sourceMain.hash } } },
          requirements,
          repositoryBinding: { status: bindings.length && !unboundCriterionIds.length ? "BOUND" as const : "UNBOUND" as const, repositories: bindings.map(r => ({ id: r.id, baseline: r.baseline })), unboundCriterionIds },
          context: { purpose: m.purpose, constraints: m.constraints, exclusions: m.exclusions, openQuestions: [...m.questions.map(q => ({ source: "MAIN" as const, ...q })), ...a.questions.map(q => ({ source: "ARCHITECTURE" as const, ...q }))] },
          verificationExpectations: requirements.flatMap(r => r.acceptanceCriteria.map(c => ({ requirementId: r.id, criterionId: c.id, description: c.description, status: "NOT_ASSESSED" as const }))),
          nextDecision: "Review this draft and resolve open questions. Separately approve exact bounded implementation scope before any native handoff. An UNBOUND repository needs an explicit baseline first.",
        };
        return { ...packet, packetHash: hash(packet) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 });
    } catch (error) {
      if ((error as { code?: string })?.code === "P2034") throw new WorkspaceError("HANDOFF_STALE");
      throw error;
    }
  }
}
