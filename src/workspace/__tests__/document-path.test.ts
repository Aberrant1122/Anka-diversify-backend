import { safePath } from "../document-contract";

describe("portable repository path boundary", () => {
  it.each([
    "../secret",
    "/etc/passwd",
    "C:/secret",
    "folder\\secret",
    ".git/config",
    ".GIT/config",
    ".git./config",
    "src./file.ts",
    ".env.local",
    "src/.env",
    "node_modules/pkg/index.js",
    "NUL/file",
    "src/CON.txt",
    "COM1/file",
    "src//file",
    "src/./file",
    "src/file:stream",
  ])("rejects protected or aliased path %s", (name) => {
    expect(() => safePath(name)).toThrow("SCOPE_PATH_INVALID");
  });
  it.each(["src/index.ts", "README.md", "docs/.keep", "src/configuration.ts"])(
    "accepts explicit regular path %s",
    (name) => expect(safePath(name)).toBe(name),
  );
});
