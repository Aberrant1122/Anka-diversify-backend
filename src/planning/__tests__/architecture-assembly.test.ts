import { assembleArchitectureContent, architectureTraceabilityMatches } from "../architecture-assembly";
import { hashArchitectureContent, parseArchitectureAuthoredDraft, renderArchitectureMarkdown } from "../architecture-schema";
import { DocumentationContent } from "../documentation-schema";
import { RequirementsContent } from "../requirements-schema";
import { architectureDraft } from "./architecture-test-fixtures";
import { PlanningArchitectureReadinessService } from "../../services/planning-architecture-readiness.service";

const req = { nonFunctionalRequirements: [{ id: "NFR-ARCH-UNIT" }], integrations: [] } as unknown as RequirementsContent;
const docs = { features: [{ id: "DOC-FEATURE", access: "controlled" }], apiContracts: { items: [{ id: "DOC-API" }] }, dataEntities: { items: [{ id: "DOC-ENTITY" }] } } as unknown as DocumentationContent;
const sourceReq = { artifactId: "req", version: 1, contentHash: "a".repeat(64) };
const sourceDoc = { artifactId: "doc", version: 1, contentHash: "b".repeat(64) };

describe("Architecture deterministic assembly", () => {
  test("normalizes content, derives server owned roots, hash and Markdown", () => {
    const draft = architectureDraft();
    const content = assembleArchitectureContent(draft, sourceReq, sourceDoc, req, docs);
    expect(content.sourceRequirements).toEqual(sourceReq);
    expect(content.traceability.features[0]).toEqual({ documentationId: "DOC-FEATURE", componentIds: ["ARCH-COMP-API"] });
    expect(architectureTraceabilityMatches(content, docs, req)).toBe(true);
    expect(hashArchitectureContent(content)).toBe(hashArchitectureContent(assembleArchitectureContent(draft, sourceReq, sourceDoc, req, docs)));
    expect(renderArchitectureMarkdown(content).endsWith("\n")).toBe(true);
    expect(renderArchitectureMarkdown(content).endsWith("\n\n")).toBe(false);
  });
  test("rejects caller owned provenance, duplicate IDs, and dangling references", () => {
    expect(() => parseArchitectureAuthoredDraft({ ...architectureDraft(), sourceRequirements: sourceReq })).toThrow();
    const duplicate = architectureDraft(); duplicate.components.push({ ...duplicate.components[0] });
    expect(() => parseArchitectureAuthoredDraft(duplicate)).toThrow();
    const dangling = architectureDraft(); dangling.components[0].documentationFeatureIds = ["DOC-MISSING"];
    expect(() => assembleArchitectureContent(dangling, sourceReq, sourceDoc, req, docs)).toThrow();
  });
  test("rejects applicable empty design and dependency sequence violations", () => {
    const empty = architectureDraft(); empty.dataDesign.items = [];
    expect(() => parseArchitectureAuthoredDraft(empty)).toThrow();
    const order = architectureDraft();
    order.components.push({ ...order.components[0], id: "ARCH-COMP-WORKER", dependencyIds: ["ARCH-COMP-API"], documentationFeatureIds: [] });
    order.implementationSequence = ["ARCH-COMP-WORKER", "ARCH-COMP-API"];
    expect(() => assembleArchitectureContent(order, sourceReq, sourceDoc, req, docs)).toThrow();
  });
  test("readiness blocks untreated controlled features, NFRs and required integrations", () => {
    const draft = architectureDraft();
    draft.crossCuttingDesign.enforcedFeatureIds = [];
    draft.crossCuttingDesign.nfrTreatments = [];
    const withIntegration = { ...req, integrations: [{ id: "INT-ARCH-UNIT", name: "External", description: "Required", required: true }] } as RequirementsContent;
    const content = assembleArchitectureContent(draft, sourceReq, sourceDoc, withIntegration, docs);
    const artifact = { id: "architecture-1", structuredContent: content, schemaVersion: 1, contentHash: hashArchitectureContent(content), content: renderArchitectureMarkdown(content) };
    const authority = { requirements: { content: withIntegration, artifact: { id: sourceReq.artifactId, version: 1, contentHash: sourceReq.contentHash } }, documentation: { content: docs, artifact: { id: sourceDoc.artifactId, version: 1, contentHash: sourceDoc.contentHash } } };
    const result = new PlanningArchitectureReadinessService().evaluateArchitecture(artifact, authority);
    expect(result.ready).toBe(false);
    expect(result.blockers.map((item) => item.code)).toEqual(expect.arrayContaining(["ARCH_AUTHORIZATION_MISSING", "ARCH_NFR_TREATMENT_MISSING", "ARCH_INTEGRATION_DESIGN_MISSING"]));
  });
  test("readiness blocks missing interface and data design; forged traceability is rejected", () => {
    const draft = architectureDraft();
    draft.interfaceDesign = { applicable: false, rationale: "Claimed no interface", items: [] };
    draft.dataDesign = { applicable: false, rationale: "Claimed no data", items: [] };
    const content = assembleArchitectureContent(draft, sourceReq, sourceDoc, req, docs);
    const artifact = { id: "architecture-2", structuredContent: content, schemaVersion: 1, contentHash: hashArchitectureContent(content), content: renderArchitectureMarkdown(content) };
    const authority = { requirements: { content: req, artifact: { id: sourceReq.artifactId, version: 1, contentHash: sourceReq.contentHash } }, documentation: { content: docs, artifact: { id: sourceDoc.artifactId, version: 1, contentHash: sourceDoc.contentHash } } };
    const result = new PlanningArchitectureReadinessService().evaluateArchitecture(artifact, authority);
    expect(result.blockers.map((item) => item.code)).toEqual(expect.arrayContaining(["ARCH_INTERFACE_DESIGN_MISSING", "ARCH_DATA_DESIGN_MISSING"]));
    const forged = { ...content, traceability: { ...content.traceability, features: [] } };
    expect(architectureTraceabilityMatches(forged, docs, req)).toBe(false);
  });
});
