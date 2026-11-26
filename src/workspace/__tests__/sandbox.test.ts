import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import {
  DockerSandbox,
  DockerCommandError,
  ContainerProcess,
  SandboxRequest,
} from "../sandbox";
import { hash } from "../document-contract";
const image = "sha256:" + "a".repeat(64),
  nonce = randomUUID();
const request: SandboxRequest = {
  protocol: 1,
  nonce,
  inputHash: hash("snapshot"),
  commands: [
    {
      id: "CMD-TEST",
      unitId: "UNIT-NOTE",
      repositoryId: "repo",
      criterionId: "AC-001",
      argv: ["node", "test.js"],
      cwd: ".",
      timeoutMs: 1000,
    },
  ],
};
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "anka-sandbox-contract-"),
);
class Engine implements ContainerProcess {
  calls: { args: string[]; input: string; timeoutMs: number }[] = [];
  runtimes: Record<string, unknown> = { runsc: {} };
  label = "1";
  resultPatch: any = {};
  exitCode = 0;
  failRun = false;
  failCleanup = false;
  autoRemoved = false;
  async run(args: string[], input: string, timeoutMs: number) {
    this.calls.push({ args, input, timeoutMs });
    if (args[0] === "info") return JSON.stringify(this.runtimes);
    if (args[0] === "image")
      return JSON.stringify({
        Id: image,
        Config: { Labels: { "org.anka.sandbox.protocol": this.label } },
      });
    if (args[0] === "rm") {
      if (this.failCleanup) throw Error("daemon unavailable");
      if (this.autoRemoved) throw new DockerCommandError(true);
      return "";
    }
    if (args[0] === "run") {
      if (this.failRun) throw Error("runtime failed");
      const r = JSON.parse(input);
      return JSON.stringify({
        protocol: 1,
        nonce: r.nonce,
        inputHash: r.inputHash,
        results: r.commands.map((c: any) => ({
          id: c.id,
          unitId: c.unitId,
          criterionId: c.criterionId,
          exitCode: this.exitCode,
          timedOut: false,
          stdout: "contract fixture",
          stderr: "",
        })),
        ...this.resultPatch,
      });
    }
    throw Error("Unexpected container command");
  }
}
describe("hardened container policy contract (no Docker daemon is invoked)", () => {
  it("stays disabled even with a valid image unless explicitly configured", async () => {
    const e = new Engine(),
      s = new DockerSandbox(
        { enabled: false, imageId: image, runtime: "runsc" },
        e,
      );
    expect(await s.ready()).toBe(false);
    await expect(s.run(directory, request)).rejects.toMatchObject({
      code: "ISOLATED_RUNTIME_UNAVAILABLE",
    });
    expect(e.calls).toHaveLength(0);
  });
  it.each(["runc", "", undefined])(
    "rejects unhardened runtime %s",
    async (runtime) => {
      const e = new Engine();
      expect(
        await new DockerSandbox(
          { enabled: true, imageId: image, runtime: runtime as never },
          e,
        ).ready(),
      ).toBe(false);
      expect(e.calls).toHaveLength(0);
    },
  );
  it("requires the configured hardened runtime and reviewed protocol image", async () => {
    const e = new Engine(),
      s = new DockerSandbox(
        { enabled: true, imageId: image, runtime: "runsc" },
        e,
      );
    e.runtimes = { runc: {} };
    expect(await s.ready()).toBe(false);
    e.runtimes = { runsc: {} };
    e.label = "unknown";
    expect(await s.ready()).toBe(false);
  });
  it("pins isolation flags, read-only input, bounded resources and exact cleanup", async () => {
    const e = new Engine(),
      s = new DockerSandbox(
        { enabled: true, imageId: image, runtime: "runsc" },
        e,
      ),
      r = await s.run(directory, request);
    expect(r.passed).toBe(true);
    const invocation = e.calls.find((c) => c.args[0] === "run")!;
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "--pull=never",
        "--runtime",
        "runsc",
        "--network=none",
        "--read-only",
        "--user=65532:65532",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=64",
        "--memory=512m",
        "--memory-swap=512m",
        "--cpus=1",
        image,
      ]),
    );
    expect(invocation.args.join(" ")).not.toMatch(
      /--privileged|docker\.sock|--network=host/,
    );
    expect(invocation.args.find((a) => a.startsWith("type=bind"))).toMatch(
      /target=\/input,readonly$/,
    );
    expect(e.calls[e.calls.length - 1]?.args).toEqual([
      "rm",
      "--force",
      "anka-document-" + nonce,
    ]);
  });
  it("computes failure from exit evidence, regardless of a claimed passed field", async () => {
    const e = new Engine();
    e.exitCode = 1;
    e.resultPatch = { passed: true };
    const s = new DockerSandbox(
      { enabled: true, imageId: image, runtime: "runsc" },
      e,
    );
    expect((await s.run(directory, request)).passed).toBe(false);
  });
  it("rejects forged job identity and still cleans up", async () => {
    const e = new Engine();
    e.resultPatch = { nonce: randomUUID() };
    await expect(
      new DockerSandbox(
        { enabled: true, imageId: image, runtime: "runsc" },
        e,
      ).run(directory, request),
    ).rejects.toMatchObject({ code: "SANDBOX_RESULT_INVALID" });
    expect(e.calls[e.calls.length - 1]?.args[0]).toBe("rm");
  });
  it("does not report success when cleanup is unconfirmed", async () => {
    const e = new Engine();
    e.failCleanup = true;
    await expect(
      new DockerSandbox(
        { enabled: true, imageId: image, runtime: "runsc" },
        e,
      ).run(directory, request),
    ).rejects.toMatchObject({ code: "SANDBOX_CLEANUP_UNCONFIRMED" });
  });
  it("accepts Docker-confirmed automatic removal", async () => {
    const e = new Engine();
    e.autoRemoved = true;
    expect(
      (
        await new DockerSandbox(
          { enabled: true, imageId: image, runtime: "runsc" },
          e,
        ).run(directory, request)
      ).passed,
    ).toBe(true);
  });
  it.each([
    ["sh", "-c", "echo bypass"],
    ["powershell", "-Command", "anything"],
    ["/bin/node", "test.js"],
  ])(
    "rejects direct shell/absolute executable %j before dispatch",
    async (...argv) => {
      const e = new Engine();
      await expect(
        new DockerSandbox(
          { enabled: true, imageId: image, runtime: "runsc" },
          e,
        ).run(directory, {
          ...request,
          commands: [{ ...request.commands[0], argv: argv as string[] }],
        }),
      ).rejects.toMatchObject({ code: "COMMAND_POLICY_INVALID" });
      expect(e.calls).toHaveLength(0);
    },
  );
  it("rejects traversal and over-budget commands before dispatch", async () => {
    const e = new Engine(),
      s = new DockerSandbox(
        { enabled: true, imageId: image, runtime: "runsc" },
        e,
      );
    await expect(
      s.run(directory, {
        ...request,
        commands: [{ ...request.commands[0], cwd: "../outside" }],
      }),
    ).rejects.toMatchObject({ code: "SCOPE_PATH_INVALID" });
    await expect(
      s.run(directory, {
        ...request,
        commands: [{ ...request.commands[0], timeoutMs: 30001 }],
      }),
    ).rejects.toMatchObject({ code: "COMMAND_POLICY_INVALID" });
    expect(e.calls).toHaveLength(0);
  });
});
