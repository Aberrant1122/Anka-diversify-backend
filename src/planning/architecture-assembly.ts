import { canonicalJson } from "./requirements-context";
import { DocumentationContent } from "./documentation-schema";
import { RequirementsContent } from "./requirements-schema";
import {
  ArchitectureAuthoredDraft, ArchitectureContent, ArchitectureSource,
  ArchitectureTraceability, ArchitectureValidationError, parseArchitectureAuthoredDraft,
  parseArchitectureContent,
} from "./architecture-schema";

export function validateArchitectureReferences(
  draft: ArchitectureAuthoredDraft,
  documentation: DocumentationContent,
  requirements: RequirementsContent,
): void {
  const components = new Set(draft.components.map((item) => item.id));
  const features = new Set(documentation.features.map((item) => item.id));
  const interfaces = new Set(documentation.apiContracts.items.map((item) => item.id));
  const entities = new Set(documentation.dataEntities.items.map((item) => item.id));
  const nfrs = new Set(requirements.nonFunctionalRequirements.map((item) => item.id));
  const integrations = new Set(requirements.integrations.map((item) => item.id));
  const requireRef = (valid: Set<string>, id: string, path: string) => {
    if (!valid.has(id)) throw new ArchitectureValidationError("Unknown approved authority reference.", path);
  };
  for (const component of draft.components) {
    for (const id of component.dependencyIds) requireRef(components, id, `components.${component.id}.dependencyIds`);
    if (component.dependencyIds.includes(component.id)) throw new ArchitectureValidationError("Component cannot depend on itself.", `components.${component.id}.dependencyIds`);
    for (const id of component.documentationFeatureIds) requireRef(features, id, `components.${component.id}.documentationFeatureIds`);
  }
  for (const item of draft.dataDesign.items) {
    requireRef(components, item.componentId, `dataDesign.${item.id}.componentId`);
    requireRef(entities, item.documentationEntityId, `dataDesign.${item.id}.documentationEntityId`);
  }
  for (const item of draft.interfaceDesign.items) {
    requireRef(components, item.componentId, `interfaceDesign.${item.id}.componentId`);
    requireRef(interfaces, item.documentationApiId, `interfaceDesign.${item.id}.documentationApiId`);
  }
  for (const item of draft.integrationDesign.items) {
    requireRef(components, item.componentId, `integrationDesign.${item.id}.componentId`);
    if (!item.requirementIntegrationIds.length) throw new ArchitectureValidationError("Integration design must reference approved Requirements integration authority.", `integrationDesign.${item.id}.requirementIntegrationIds`);
    for (const id of item.requirementIntegrationIds) requireRef(integrations, id, `integrationDesign.${item.id}.requirementIntegrationIds`);
  }
  for (const item of draft.crossCuttingDesign.nfrTreatments) requireRef(nfrs, item.requirementId, `crossCuttingDesign.${item.requirementId}`);
  for (const id of draft.crossCuttingDesign.enforcedFeatureIds) requireRef(features, id, "crossCuttingDesign.enforcedFeatureIds");
  const sequence = draft.implementationSequence;
  if (sequence.length !== components.size || sequence.some((id) => !components.has(id))) throw new ArchitectureValidationError("Implementation sequence must list every component exactly once.", "implementationSequence");
  const position = new Map(sequence.map((id, index) => [id, index]));
  for (const component of draft.components) {
    for (const dependency of component.dependencyIds) {
      if ((position.get(dependency) ?? Infinity) >= (position.get(component.id) ?? -1)) throw new ArchitectureValidationError("Implementation sequence violates component dependencies or contains a cycle.", "implementationSequence");
    }
  }
}

export function deriveArchitectureTraceability(
  draft: ArchitectureAuthoredDraft,
  documentation: DocumentationContent,
  requirements: RequirementsContent,
): ArchitectureTraceability {
  return {
    features: documentation.features.map((feature) => ({ documentationId: feature.id, componentIds: draft.components.filter((component) => component.documentationFeatureIds.includes(feature.id)).map((component) => component.id).sort() })).sort((a, b) => a.documentationId.localeCompare(b.documentationId)),
    interfaces: documentation.apiContracts.items.map((api) => ({ documentationId: api.id, designIds: draft.interfaceDesign.items.filter((item) => item.documentationApiId === api.id).map((item) => item.id).sort() })).sort((a, b) => a.documentationId.localeCompare(b.documentationId)),
    dataEntities: documentation.dataEntities.items.map((entity) => ({ documentationId: entity.id, designIds: draft.dataDesign.items.filter((item) => item.documentationEntityId === entity.id).map((item) => item.id).sort() })).sort((a, b) => a.documentationId.localeCompare(b.documentationId)),
    nonFunctionalRequirements: requirements.nonFunctionalRequirements.map((nfr) => ({ requirementId: nfr.id, treated: draft.crossCuttingDesign.nfrTreatments.some((item) => item.requirementId === nfr.id) })).sort((a, b) => a.requirementId.localeCompare(b.requirementId)),
  };
}

export function assembleArchitectureContent(
  authoredInput: unknown,
  sourceRequirements: ArchitectureSource,
  sourceDocumentation: ArchitectureSource,
  requirements: RequirementsContent,
  documentation: DocumentationContent,
): ArchitectureContent {
  const authored = parseArchitectureAuthoredDraft(authoredInput);
  validateArchitectureReferences(authored, documentation, requirements);
  return parseArchitectureContent({
    ...authored,
    traceability: deriveArchitectureTraceability(authored, documentation, requirements),
    sourceRequirements,
    sourceDocumentation,
  });
}

export function architectureTraceabilityMatches(
  content: ArchitectureContent,
  documentation: DocumentationContent,
  requirements: RequirementsContent,
): boolean {
  validateArchitectureReferences(content, documentation, requirements);
  return canonicalJson(content.traceability) === canonicalJson(deriveArchitectureTraceability(content, documentation, requirements));
}
