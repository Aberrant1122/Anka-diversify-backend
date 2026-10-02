import { canonicalJson } from "../../planning/requirements-context";

export function serializeUntrustedRequirementsContext(value: unknown): string {
  return canonicalJson(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}
