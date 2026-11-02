import { execFile } from "child_process";
import path from "path";
import { WorkspaceError } from "./document-contract";

export function workspaceGit(
  cwd: string,
  args: string[],
  options: { runsRoot: string; token?: string; timeoutMs?: number },
): Promise<string> {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
  if (options.token) {
    environment.GIT_CONFIG_COUNT = "1";
    environment.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    environment.GIT_CONFIG_VALUE_0 =
      "Authorization: Basic " +
      Buffer.from("x-access-token:" + options.token).toString("base64");
  }
  return new Promise((resolve, reject) =>
    execFile(
      "git",
      [
        "-c",
        "core.hooksPath=" + path.join(options.runsRoot, "disabled-hooks"),
        "-c",
        "core.fsmonitor=false",
        "-c",
        "protocol.ext.allow=never",
        ...args,
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: options.timeoutMs ?? 15000,
        maxBuffer: 2 * 1024 * 1024,
        env: environment,
      },
      (error, out) =>
        error
          ? reject(new WorkspaceError("GIT_BASELINE_UNAVAILABLE"))
          : resolve(out.trim()),
    ),
  );
}
