export interface GroundedSemanticQueryInput {
  message: string;
  targetPath?: string;
  discoveredSymbols?: string[];
  discoveredServices?: string[];
  discoveredModels?: string[];
  discoveredRoutes?: string[];
}

/**
 * Builds grounded multi-query semantic retrieval queries from verified repository discoveries.
 *
 * Rules:
 * 1. Original user message is always query #1.
 * 2. Maximum 4 queries total.
 * 3. Never calls an LLM or invents synonyms.
 * 4. Combines targetPath, top discovered symbols (max 3), and combined entities (max 4).
 * 5. Deterministic, deduplicated, whitespace-normalized.
 */
export function buildGroundedSemanticQueries(input: GroundedSemanticQueryInput): string[] {
  const rawMessage = typeof input?.message === "string" ? input.message : "";
  const message = rawMessage.trim().replace(/\s+/g, " ");

  if (!message) {
    return [];
  }

  const rawQueries: string[] = [message];

  // 1. Target path grounded query
  if (typeof input.targetPath === "string") {
    const trimmedPath = input.targetPath.trim().replace(/\s+/g, " ");
    if (trimmedPath) {
      rawQueries.push(`${message} ${trimmedPath}`);
    }
  }

  // 2. Discovered symbols query (max 3 unique symbols)
  if (Array.isArray(input.discoveredSymbols) && input.discoveredSymbols.length > 0) {
    const seenSymbols = new Set<string>();
    const validSymbols: string[] = [];

    for (const s of input.discoveredSymbols) {
      if (typeof s === "string") {
        const trimmed = s.trim().replace(/\s+/g, " ");
        if (trimmed && !seenSymbols.has(trimmed)) {
          seenSymbols.add(trimmed);
          validSymbols.push(trimmed);
        }
      }
    }

    const topSymbols = validSymbols.slice(0, 3);
    if (topSymbols.length > 0) {
      rawQueries.push(`${message} ${topSymbols.join(" ")}`);
    }
  }

  // 3. Combined repository entities query (max 4 unique from services, models, routes)
  const seenEntities = new Set<string>();
  const candidateEntities: string[] = [];

  const addEntity = (item: any) => {
    if (typeof item === "string") {
      const trimmed = item.trim().replace(/\s+/g, " ");
      if (trimmed && !seenEntities.has(trimmed)) {
        seenEntities.add(trimmed);
        candidateEntities.push(trimmed);
      }
    }
  };

  if (Array.isArray(input.discoveredServices)) {
    for (const item of input.discoveredServices) addEntity(item);
  }

  if (Array.isArray(input.discoveredModels)) {
    for (const item of input.discoveredModels) addEntity(item);
  }

  if (Array.isArray(input.discoveredRoutes)) {
    for (const item of input.discoveredRoutes) addEntity(item);
  }

  const selectedEntities = candidateEntities.slice(0, 4);
  if (selectedEntities.length > 0) {
    rawQueries.push(`${message} ${selectedEntities.join(" ")}`);
  }

  // Deduplicate queries preserving deterministic order, and cap at max 4
  const seen = new Set<string>();
  const finalQueries: string[] = [];

  for (const q of rawQueries) {
    const normalized = q.trim().replace(/\s+/g, " ");
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      finalQueries.push(normalized);
    }
  }

  return finalQueries.slice(0, 4);
}
