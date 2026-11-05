import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import {
  VerificationCommand,
  WorkspaceError,
  hash,
  parseCommands,
} from "./document-contract";
export interface PlannedCommand extends VerificationCommand {
  unitId: string;
  repositoryId: string;
}
export interface CommandResult {
  id: string;
  unitId: string;
  criterionId: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}
export interface SandboxRequest {
  protocol: 1;
  nonce: string;
  inputHash: string;
  commands: PlannedCommand[];
}
export interface SandboxOutcome {
  evidenceClass: "DYNAMIC_ISOLATED_COMMAND_CHECKS" | "CONTRACT_TEST";
  imageId: string;
  runtime: string;
  inputHash: string;
  commandsHash: string;
  results: CommandResult[];
  passed: boolean;
}
export interface SandboxAdapter {
  ready(): Promise<boolean>;
  run(inputDirectory: string, request: SandboxRequest): Promise<SandboxOutcome>;
  cleanup?(nonce: string): Promise<void>;
}
export interface ContainerProcess {
  run(args: string[], input: string, timeoutMs: number): Promise<string>;
}
export class DockerCommandError extends WorkspaceError {
  constructor(public missingContainer: boolean) {
    super("ISOLATED_RUNTIME_FAILED", 503);
  }
}
export class DockerProcess implements ContainerProcess {
  run(args: string[], input: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "docker",
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
          },
        },
        (error, out, stderr) =>
          error
            ? reject(new DockerCommandError(/No such container:/i.test(stderr)))
            : resolve(out),
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  }
}
export interface DockerPolicy {
  enabled: boolean;
  imageId: string;
  runtime: "runsc" | "kata-runtime";
}
export const dockerPolicyFromEnvironment = (): DockerPolicy => ({
  enabled: process.env.ANKA_DOCUMENT_SANDBOX_ENABLED === "true",
  imageId: process.env.ANKA_DOCUMENT_SANDBOX_IMAGE || "",
  runtime: process.env.ANKA_DOCUMENT_SANDBOX_RUNTIME as DockerPolicy["runtime"],
});
export function validateSandboxRequest(request: SandboxRequest): void {
  if (
    request.protocol !== 1 ||
    !/^[a-f0-9-]{36}$/.test(request.nonce) ||
    !/^[a-f0-9]{64}$/.test(request.inputHash) ||
    !Array.isArray(request.commands) ||
    !request.commands.length ||
    request.commands.length > 8 ||
    request.commands.reduce((n, c) => n + c.timeoutMs, 0) > 120000
  )
    throw new WorkspaceError("COMMAND_BUDGET_EXCEEDED", 422);
  const seen = new Set<string>();
  for (const c of request.commands) {
    parseCommands(
      [
        {
          id: c.id,
          criterionId: c.criterionId,
          argv: c.argv,
          cwd: c.cwd,
          timeoutMs: c.timeoutMs,
        },
      ],
      new Set([c.criterionId]),
    );
    const key = c.unitId + ":" + c.id;
    if (
      typeof c.repositoryId !== "string" ||
      typeof c.unitId !== "string" ||
      !/^UNIT-[A-Z0-9-]+$/.test(c.unitId) ||
      seen.has(key)
    )
      throw new WorkspaceError("COMMAND_POLICY_INVALID", 422);
    seen.add(key);
  }
}
export class DockerSandbox implements SandboxAdapter {
  constructor(
    private policy: DockerPolicy = dockerPolicyFromEnvironment(),
    private process: ContainerProcess = new DockerProcess(),
  ) {}
  private configured() {
    return (
      this.policy.enabled &&
      /^sha256:[a-f0-9]{64}$/.test(this.policy.imageId) &&
      ["runsc", "kata-runtime"].includes(this.policy.runtime)
    );
  }
  async cleanup(nonce: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(nonce))
      throw new WorkspaceError("SANDBOX_JOB_INVALID");
    try {
      await this.process.run(
        ["rm", "--force", "anka-document-" + nonce],
        "",
        5000,
      );
    } catch (e) {
      if (!(e instanceof DockerCommandError && e.missingContainer))
        throw new WorkspaceError("SANDBOX_CLEANUP_UNCONFIRMED", 503);
    }
  }
  async ready(): Promise<boolean> {
    if (!this.configured()) return false;
    try {
      const runtimes = JSON.parse(
        await this.process.run(
          ["info", "--format", "{{json .Runtimes}}"],
          "",
          3000,
        ),
      );
      if (!runtimes[this.policy.runtime]) return false;
      const image = JSON.parse(
        await this.process.run(
          ["image", "inspect", "--format", "{{json .}}", this.policy.imageId],
          "",
          3000,
        ),
      );
      return (
        image.Id === this.policy.imageId &&
        image.Config?.Labels?.["org.anka.sandbox.protocol"] === "1"
      );
    } catch {
      return false;
    }
  }
  async run(
    inputDirectory: string,
    request: SandboxRequest,
  ): Promise<SandboxOutcome> {
    validateSandboxRequest(request);
    if (!(await this.ready()))
      throw new WorkspaceError("ISOLATED_RUNTIME_UNAVAILABLE", 503);
    const input = fs.realpathSync(inputDirectory);
    if (
      fs.lstatSync(inputDirectory).isSymbolicLink() ||
      !fs.statSync(input).isDirectory() ||
      input.includes(",")
    )
      throw new WorkspaceError("SANDBOX_INPUT_INVALID");
    const name = "anka-document-" + request.nonce;
    const timeout =
      request.commands.reduce((n, c) => n + c.timeoutMs, 0) + 20000;
    const args = [
      "run",
      "--rm",
      "--pull=never",
      "--name",
      name,
      "--runtime",
      this.policy.runtime,
      "--network=none",
      "--read-only",
      "--user=65532:65532",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=64",
      "--memory=512m",
      "--memory-swap=512m",
      "--cpus=1",
      "--ulimit=nofile=256:256",
      "--ipc=none",
      "--log-driver=none",
      "--mount",
      `type=bind,source=${input},target=/input,readonly`,
      "--tmpfs",
      "/work:rw,nosuid,nodev,size=268435456,uid=65532,gid=65532,mode=0700",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=67108864,uid=65532,gid=65532,mode=0700",
      "--entrypoint",
      "/usr/local/bin/node",
      "-i",
      this.policy.imageId,
      "/opt/anka/runner.cjs",
    ];
    try {
      const raw = JSON.parse(
        await this.process.run(args, JSON.stringify(request), timeout),
      );
      if (
        raw.protocol !== 1 ||
        raw.nonce !== request.nonce ||
        raw.inputHash !== request.inputHash ||
        !Array.isArray(raw.results) ||
        raw.results.length !== request.commands.length
      )
        throw new WorkspaceError("SANDBOX_RESULT_INVALID");
      const results = raw.results.map((result: any, index: number) => {
        const command = request.commands[index];
        if (
          result.id !== command.id ||
          result.unitId !== command.unitId ||
          result.criterionId !== command.criterionId ||
          !(result.exitCode === null || Number.isInteger(result.exitCode)) ||
          typeof result.timedOut !== "boolean" ||
          typeof result.stdout !== "string" ||
          typeof result.stderr !== "string" ||
          result.stdout.length > 65536 ||
          result.stderr.length > 65536
        )
          throw new WorkspaceError("SANDBOX_RESULT_INVALID");
        return {
          id: command.id,
          unitId: command.unitId,
          criterionId: command.criterionId,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
        } as CommandResult;
      });
      return {
        evidenceClass: "DYNAMIC_ISOLATED_COMMAND_CHECKS",
        imageId: this.policy.imageId,
        runtime: this.policy.runtime,
        inputHash: request.inputHash,
        commandsHash: hash(request.commands),
        results,
        passed: results.every(
          (r: CommandResult) => r.exitCode === 0 && !r.timedOut,
        ),
      };
    } finally {
      // A killed Docker client does not guarantee a stopped container. Always
      // remove only the exact generated job name; never fall back to a host command.
      await this.cleanup(request.nonce);
    }
  }
}

// Protocol 1 remains unchanged; protocol 2 cannot enter DockerSandbox.
export type VersionedSandboxRequest = SandboxRequest | import("./baseline-protocol").BaselineRequest2;
