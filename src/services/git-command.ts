import { execFile } from "child_process";

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCommandExecutor {
  run(cwd: string, args: readonly string[], options?: GitCommandOptions): Promise<GitCommandResult>;
}

export interface GitCommandOptions {
  readonly timeoutMs?: number;
  readonly environment?: Readonly<Record<string, string>>;
}

function redact(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(?:ghp_|github_pat_|glpat-)[A-Za-z0-9_-]+\b/g, "[REDACTED]");
}

export class GitCommandError extends Error {
  constructor(
    message: string,
    public readonly args: readonly string[],
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

/** Executes Git without a shell. Arguments are always passed as an argv array. */
export class NodeGitCommandExecutor implements GitCommandExecutor {
  public async run(cwd: string, args: readonly string[], options: GitCommandOptions = {}): Promise<GitCommandResult> {
    return new Promise((resolve, reject) => {
      execFile("git", [...args], {
        cwd,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        timeout: options.timeoutMs,
        env: { ...process.env, ...options.environment, GIT_TERMINAL_PROMPT: "0" },
      }, (error, stdout, stderr) => {
        const safeStdout = redact(String(stdout ?? ""));
        const safeStderr = redact(String(stderr ?? "")).slice(0, 4_000);
        if (error) {
          reject(new GitCommandError(
            `Git command failed: ${safeStderr || redact(error.message).slice(0, 4_000)}`,
            Object.freeze(args.map((arg) => redact(arg))),
            safeStderr,
          ));
          return;
        }
        resolve(Object.freeze({ stdout: safeStdout, stderr: safeStderr }));
      });
    });
  }
}
