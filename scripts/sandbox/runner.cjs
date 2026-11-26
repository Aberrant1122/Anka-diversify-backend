// Trusted image entrypoint. Repository commands run only inside the configured
// hardened container, with no secrets/network/host write mounts.
const fs = require("node:fs"),
  path = require("node:path"),
  { spawn } = require("node:child_process");
(async () => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 100000) throw new Error("Protocol input too large");
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString());
  if (
    request.protocol !== 1 ||
    !Array.isArray(request.commands) ||
    request.commands.length > 8
  )
    throw new Error("Invalid protocol");
  const root = "/work/repository";
  fs.cpSync("/input", root, { recursive: true, dereference: false });
  const results = [];
  for (const command of request.commands) {
    const cwd = path.resolve(root, command.cwd),
      relative = path.relative(root, cwd);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !fs.statSync(cwd).isDirectory()
    )
      throw new Error("Invalid command directory");
    const result = await new Promise((resolve) => {
      let stdout = "",
        stderr = "",
        timedOut = false,
        settled = false;
      const child = spawn(command.argv[0], command.argv.slice(1), {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: "/opt/anka/bin:/usr/local/bin:/usr/bin:/bin",
          HOME: "/tmp",
          TMPDIR: "/tmp",
          CI: "true",
          NODE_ENV: "test",
          NODE_PATH: "/opt/anka/node_modules",
          npm_config_offline: "true",
          npm_config_audit: "false",
          npm_config_fund: "false",
        },
      });
      const stop = () => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, command.timeoutMs);
      const add = (kind, data) => {
        if (kind === "stdout") stdout += data.toString();
        else stderr += data.toString();
        if (stdout.length > 65536 || stderr.length > 65536) {
          timedOut = true;
          stop();
        }
      };
      child.stdout.on("data", (data) => add("stdout", data));
      child.stderr.on("data", (data) => add("stderr", data));
      const finish = (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stop();
        resolve({
          id: command.id,
          unitId: command.unitId,
          criterionId: command.criterionId,
          exitCode,
          timedOut,
          stdout: stdout.slice(0, 65536),
          stderr: stderr.slice(0, 65536),
        });
      };
      child.on("error", () => finish(null));
      child.on("close", (code) => finish(code));
    });
    results.push(result);
  }
  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      nonce: request.nonce,
      inputHash: request.inputHash,
      results,
    }),
  );
})().catch(() => {
  process.stderr.write("Sandbox protocol/command environment failed");
  process.exitCode = 1;
});
