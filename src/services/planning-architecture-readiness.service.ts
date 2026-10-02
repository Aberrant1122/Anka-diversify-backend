import { architectureTraceabilityMatches } from "../planning/architecture-assembly";
import {
  ARCHITECTURE_CANONICAL_JSON_MAX_BYTES, ARCHITECTURE_SCHEMA_VERSION,
  ArchitectureContent, hashArchitectureContent, parseArchitectureContent,
  renderArchitectureMarkdown,
} from "../planning/architecture-schema";
import { DocumentationContent } from "../planning/documentation-schema";
import { canonicalJson } from "../planning/requirements-context";
import { RequirementsContent } from "../planning/requirements-schema";

export interface ArchitectureReadinessItem { code: string; message: string; itemIds?: string[] }
export interface ArchitectureReadiness {
  ready: boolean; artifactId: string; contentHash: string;
  blockers: ArchitectureReadinessItem[]; warnings: ArchitectureReadinessItem[];
}
export interface ArchitectureReadinessArtifact {
  id: string; content: string; structuredContent: unknown; contentHash: string | null; schemaVersion: number;
}
export interface ArchitectureReadinessAuthority {
  requirements: { content: RequirementsContent; artifact: { id: string; version: number; contentHash: string | null } };
  documentation: { content: DocumentationContent; artifact: { id: string; version: number; contentHash: string | null } };
}

export class PlanningArchitectureReadinessService {
  evaluateArchitecture(artifact: ArchitectureReadinessArtifact, authority: ArchitectureReadinessAuthority): ArchitectureReadiness {
    const blockers: ArchitectureReadinessItem[] = [];
    const warnings: ArchitectureReadinessItem[] = [];
    const block = (code: string, message: string, itemIds?: string[]) => blockers.push({ code, message, ...(itemIds?.length ? { itemIds: itemIds.sort() } : {}) });
    let content: ArchitectureContent;
    try { content = parseArchitectureContent(artifact.structuredContent); }
    catch { return { ready: false, artifactId: artifact.id, contentHash: artifact.contentHash ?? "", blockers: [{ code: "ARCH_CANONICAL_INVALID", message: "Architecture canonical content is invalid." }], warnings }; }
    if (artifact.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION) block("ARCH_SCHEMA_INVALID", "Architecture schema version is invalid.");
    if (canonicalJson(artifact.structuredContent) !== canonicalJson(content)) block("ARCH_CANONICAL_INVALID", "Architecture structured content is not normalized.");
    if (Buffer.byteLength(canonicalJson(content), "utf8") > ARCHITECTURE_CANONICAL_JSON_MAX_BYTES) block("ARCH_SIZE_EXCEEDED", "Architecture canonical JSON exceeds the UTF-8 limit.");
    if (artifact.contentHash !== hashArchitectureContent(content)) block("ARCH_HASH_MISMATCH", "Architecture hash is invalid.");
    if (artifact.content !== renderArchitectureMarkdown(content)) block("ARCH_RENDER_MISMATCH", "Architecture Markdown is invalid.");
    const sourceMatches = (source: { artifactId: string; version: number; contentHash: string }, artifactRecord: { id: string; version: number; contentHash: string | null }) => source.artifactId === artifactRecord.id && source.version === artifactRecord.version && source.contentHash === artifactRecord.contentHash;
    if (!sourceMatches(content.sourceRequirements, authority.requirements.artifact)) block("ARCH_REQUIREMENTS_STALE", "Requirements authority has changed.");
    if (!sourceMatches(content.sourceDocumentation, authority.documentation.artifact)) block("ARCH_DOCUMENTATION_STALE", "Documentation authority has changed.");
    try {
      if (!architectureTraceabilityMatches(content, authority.documentation.content, authority.requirements.content)) block("ARCH_TRACEABILITY_INVALID", "Server-derived traceability is inconsistent.");
    } catch { block("ARCH_REFERENCES_INVALID", "Architecture references or implementation sequence are invalid."); }
    const controlled = authority.documentation.content.features.filter((item) => item.access === "controlled");
    const ownerIds = new Set(content.traceability.features.filter((item) => item.componentIds.length > 0).map((item) => item.documentationId));
    const uncovered = authority.documentation.content.features.filter((item) => !ownerIds.has(item.id));
    if (uncovered.length) block("ARCH_FEATURE_OWNER_MISSING", "Documentation features need component ownership.", uncovered.map((item) => item.id));
    const unenforced = controlled.filter((item) => !content.crossCuttingDesign.enforcedFeatureIds.includes(item.id));
    if (unenforced.length) block("ARCH_AUTHORIZATION_MISSING", "Controlled features need explicit enforcement treatment.", unenforced.map((item) => item.id));
    const missingInterfaces = content.traceability.interfaces.filter((item) => !item.designIds.length);
    if (missingInterfaces.length) block("ARCH_INTERFACE_DESIGN_MISSING", "Documentation interfaces need implementation design.", missingInterfaces.map((item) => item.documentationId));
    const missingData = content.traceability.dataEntities.filter((item) => !item.designIds.length);
    if (missingData.length) block("ARCH_DATA_DESIGN_MISSING", "Documentation data entities need implementation design.", missingData.map((item) => item.documentationId));
    const missingIntegrations = authority.requirements.content.integrations.filter((item) => item.required && !content.integrationDesign.items.some((design) => design.requirementIntegrationIds.includes(item.id)));
    if (missingIntegrations.length) block("ARCH_INTEGRATION_DESIGN_MISSING", "Required integrations need design.", missingIntegrations.map((item) => item.id));
    const missingNfrs = content.traceability.nonFunctionalRequirements.filter((item) => !item.treated);
    if (missingNfrs.length) block("ARCH_NFR_TREATMENT_MISSING", "Non-functional Requirements need treatment.", missingNfrs.map((item) => item.requirementId));
    const blockingQuestions = content.unresolvedQuestions.filter((item) => item.blocksDecision);
    if (blockingQuestions.length) block("ARCH_BLOCKING_QUESTIONS", "Architecture decisions remain unresolved.", blockingQuestions.map((item) => item.id));
    const nonBlocking = content.unresolvedQuestions.filter((item) => !item.blocksDecision);
    if (nonBlocking.length) warnings.push({ code: "ARCH_NONBLOCKING_QUESTIONS", message: "Non-critical Architecture questions remain.", itemIds: nonBlocking.map((item) => item.id).sort() });
    return { ready: blockers.length === 0, artifactId: artifact.id, contentHash: artifact.contentHash ?? "", blockers, warnings };
  }
}
