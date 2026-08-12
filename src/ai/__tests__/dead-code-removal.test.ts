import fs from "fs";
import path from "path";

describe("Dead Code Removal Verification (Phase 6C)", () => {
  it("should confirm BuildValidator.ts is permanently deleted", () => {
    const filePath = path.join(__dirname, "..", "validation", "BuildValidator.ts");
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("should confirm RuntimeValidator.ts is permanently deleted", () => {
    const filePath = path.join(__dirname, "..", "validation", "RuntimeValidator.ts");
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("should confirm ValidationResult.ts is permanently deleted", () => {
    const filePath = path.join(__dirname, "..", "validation", "ValidationResult.ts");
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
