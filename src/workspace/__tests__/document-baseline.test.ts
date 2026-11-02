import { parseArchitecture, mainFromBrief } from "../document-contract";
const main = mainFromBrief("Maintain a note");
const architecture = (baseline: string) => ({
  schemaVersion: 1,
  sourceMain: { id: "main", hash: "a".repeat(64) },
  overview: "Note component",
  components: [{ id: "COMP-NOTE", description: "Note" }],
  dataMigrations: [],
  interfaces: [],
  security: ["Owner approval"],
  operations: ["Review diff"],
  repositories: [{ id: "repo", baseline }],
  units: [],
  questions: [],
});
describe("exact repository baseline format", () => {
  it.each([39, 41, 63, 65])("rejects a %i-character pseudo commit", (length) =>
    expect(() =>
      parseArchitecture(architecture("a".repeat(length)), main),
    ).toThrow("DOCUMENT_INVALID"),
  );
  it.each([40, 64])("accepts a %i-character exact commit format", (length) =>
    expect(
      parseArchitecture(architecture("a".repeat(length)), main).repositories[0]
        .baseline,
    ).toHaveLength(length),
  );
});
