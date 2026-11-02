import { createCorsOptions } from "../cors-policy";
import { ownerBootstrap } from "../owner-bootstrap";

describe("explicit owner bootstrap", () => {
  it.each([{}, { ADMIN_EMAIL: "owner@example.test" }, { ADMIN_EMAIL: "owner@example.test", ADMIN_PASSWORD: "short" }])("rejects absent or weak bootstrap configuration", (env) => {
    expect(() => ownerBootstrap(env)).toThrow("Explicit ADMIN_EMAIL");
  });
  it("uses explicitly supplied credentials", () => {
    expect(ownerBootstrap({ ADMIN_EMAIL: "owner@example.test", ADMIN_PASSWORD: "synthetic-test-password" }))
      .toEqual({ email: "owner@example.test", password: "synthetic-test-password", name: "Owner" });
  });
});

const { runDatabaseStartup } = require("../../../scripts/db-startup");

describe("database startup", () => {
  it("runs only versioned migrations, without account bootstrap", () => {
    const run = jest.fn();
    runDatabaseStartup(run);
    expect(run.mock.calls).toEqual([["npx prisma migrate deploy", { stdio: "inherit" }]]);
  });
  it("propagates migration failure without schema push or seed", () => {
    const run = jest.fn(() => { throw new Error("migration failed"); });
    expect(() => runDatabaseStartup(run)).toThrow("migration failed");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("CORS browser response policy", () => {
  it("preserves preflight compatibility for existing authenticated clients", () => {
    expect(createCorsOptions().allowedHeaders).toEqual(expect.arrayContaining(["Authorization", "Content-Type", "X-User-ID", "X-User-Name"]));
  });
  it.each([
    ["https://workspace.example", true],
    ["https://attacker.example", false],
    ["https://workspace.example.attacker.example", false],
    ["http://localhost:3000", false],
    ["null", false],
    [undefined, true],
  ])("production origin %s is allowed=%s", (origin, allowed) => {
    const policy = createCorsOptions({ NODE_ENV: "production", FRONTEND_URL: "https://workspace.example" });
    const callback = jest.fn();
    (policy.origin as Function)(origin, callback);
    expect(callback).toHaveBeenCalledWith(null, allowed);
  });
  it("fails closed for browser origins when production URL is missing", () => {
    const callback = jest.fn();
    (createCorsOptions({ NODE_ENV: "production" }).origin as Function)("http://localhost:3000", callback);
    expect(callback).toHaveBeenCalledWith(null, false);
  });
});
