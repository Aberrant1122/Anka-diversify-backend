import fs from "fs";
import path from "path";

describe("production startup contract", () => {
  test("builds current TypeScript before the supported production entry point", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));

    expect(packageJson.scripts.prestart).toBe("npm run build");
    expect(packageJson.scripts.build).toContain("tsc");
    expect(packageJson.scripts.start).toContain("node dist/index.js");
  });
});
