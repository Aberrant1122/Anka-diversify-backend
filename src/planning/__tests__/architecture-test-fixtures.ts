import { ArchitectureAuthoredDraft } from "../architecture-schema";

export function architectureDraft(nfrId = "NFR-ARCH-UNIT"): ArchitectureAuthoredDraft {
  return {
    overview: { approach: "Layered service", systemBoundary: "Workflow backend", technicalDirection: "Transactional API" },
    components: [{ id: "ARCH-COMP-API", name: "API", responsibility: "Manage workflow", boundary: "Backend", dependencyIds: [], documentationFeatureIds: ["DOC-FEATURE"], designNotes: "Serializable writes" }],
    dataDesign: { applicable: true, rationale: "Persist state", items: [{ id: "ARCH-DATA-STATE", documentationEntityId: "DOC-ENTITY", componentId: "ARCH-COMP-API", persistence: "PostgreSQL", lifecycle: "Project scoped", consistency: "Serializable" }] },
    interfaceDesign: { applicable: true, rationale: "Expose API", items: [{ id: "ARCH-IFACE-API", documentationApiId: "DOC-API", componentId: "ARCH-COMP-API", boundary: "HTTP", enforcement: "Owner check", transport: "REST" }] },
    integrationDesign: { applicable: false, rationale: "No external boundary", items: [] },
    crossCuttingDesign: { authorization: "Owner checks", security: "Project scoped access", reliability: "Retry serialization failures", observability: "Audit decisions", enforcedFeatureIds: ["DOC-FEATURE"], nfrTreatments: [{ requirementId: nfrId, treatment: "Audit decisions" }] },
    implementationSequence: ["ARCH-COMP-API"],
    unresolvedQuestions: [],
  };
}
