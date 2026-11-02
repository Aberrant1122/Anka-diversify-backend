import fs from "fs";
import path from "path";
import { randomUUID, createHash } from "crypto";
import { workspaceGit } from "./workspace-git";
import { ExecutionPolicy } from "./document-executor";
import { safePath, WorkspaceError, hash } from "./document-contract";
export interface ImplementationArtifact {
  bindings: { repositoryId: string; baseline: string; workspace: string }[];
  diffs: { repositoryId: string; diff: string }[];
  changeHash: string;
  unitIds: string[];
  architectureHash: string;
}
export class WorkspaceArtifacts {
  constructor(private policy: ExecutionPolicy) {}
  private contained(root: string, target: string) {
    const r = path.relative(root, target);
    return !!r && !r.startsWith("..") && !path.isAbsolute(r);
  }
  async inspect(runId: string, artifact: ImplementationArtifact) {
    if (
      !/^[a-f0-9-]{36}$/.test(runId) ||
      !Array.isArray(artifact.bindings) ||
      !artifact.bindings.length ||
      artifact.bindings.length > 3
    )
      throw new WorkspaceError("RUN_ARTIFACT_INVALID");
    const managed = fs.realpathSync(this.policy.runsRoot),
      runPath = path.join(managed, runId),
      runRoot = fs.realpathSync(runPath);
    if (
      fs.lstatSync(runPath).isSymbolicLink() ||
      !this.contained(managed, runRoot)
    )
      throw new WorkspaceError("RUN_ARTIFACT_SCOPE_MISMATCH");
    const roots = new Map<string, string>();
    for (const binding of artifact.bindings) {
      const root = fs.realpathSync(binding.workspace);
      if (
        !this.contained(runRoot, root) ||
        path.dirname(path.resolve(binding.workspace)) !== runRoot ||
        !/^\d+$/.test(path.basename(binding.workspace)) ||
        fs.lstatSync(binding.workspace).isSymbolicLink() ||
        roots.has(binding.repositoryId)
      )
        throw new WorkspaceError("RUN_ARTIFACT_SCOPE_MISMATCH");
      const gitDirectory = path.join(root, ".git");
      if (
        !fs.lstatSync(gitDirectory).isDirectory() ||
        fs.lstatSync(gitDirectory).isSymbolicLink()
      )
        throw new WorkspaceError("RUN_ARTIFACT_SCOPE_MISMATCH");
      const config = fs.readFileSync(path.join(gitDirectory, "config"), "utf8");
      if (/^\s*\[(?:filter|include|includeIf)\b/im.test(config))
        throw new WorkspaceError("EXECUTABLE_GIT_CONFIG_REJECTED");
      const git = (args: string[]) =>
        workspaceGit(root, args, { runsRoot: this.policy.runsRoot });
      const head = await git(["rev-parse", "HEAD"]);
      if (
        head !== binding.baseline &&
        (await git(["rev-parse", "HEAD^"])) !== binding.baseline
      )
        throw new WorkspaceError("RUN_ARTIFACT_HEAD_CHANGED");
      if (
        (await git(["diff", "--no-ext-diff", "--no-textconv"])) ||
        (await git(["ls-files", "--others", "--exclude-standard"]))
      )
        throw new WorkspaceError("RUN_ARTIFACT_CHANGED");
      const diff = await git([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        binding.baseline,
        "--",
      ]);
      if (
        diff !==
        artifact.diffs.find((d) => d.repositoryId === binding.repositoryId)
          ?.diff
      )
        throw new WorkspaceError("REVIEW_DIFF_MISMATCH");
      roots.set(binding.repositoryId, root);
    }
    if (roots.size !== artifact.diffs.length)
      throw new WorkspaceError("RUN_ARTIFACT_INVALID");
    return roots;
  }
  async snapshot(
    runId: string,
    artifact: ImplementationArtifact,
    repositoryId: string,
  ) {
    const roots = await this.inspect(runId, artifact),
      root = roots.get(repositoryId);
    if (!root) throw new WorkspaceError("REPOSITORY_SCOPE_MISMATCH");
    // Explicit NUL separation preserves path boundaries. No Git metadata, secret
    // files, symlinks, node_modules or host credentials enter the sandbox input.
    const names = (
      await workspaceGit(root, ["ls-files", "-z"], {
        runsRoot: this.policy.runsRoot,
      })
    )
      .split("\0")
      .filter(Boolean)
      .sort();
    const snapshotsRoot = path.join(
      this.policy.runsRoot,
      runId,
      "sandbox-inputs",
    );
    fs.mkdirSync(snapshotsRoot, { recursive: true });
    if (fs.lstatSync(snapshotsRoot).isSymbolicLink())
      throw new WorkspaceError("SYMLINK_SCOPE_REJECTED");
    const snapshot = path.join(snapshotsRoot, randomUUID());
    fs.mkdirSync(snapshot);
    let bytes = 0;
    const files: { path: string; sha256: string }[] = [],
      excluded: string[] = [];
    if (names.length > 10000)
      throw new WorkspaceError("SANDBOX_INPUT_TOO_LARGE");
    for (const name of names) {
      if (
        /(^|\/)(?:\.env[^/]*|\.npmrc|\.pypirc|\.netrc|node_modules|\.git|id_(?:rsa|ed25519)|[^/]*\.(?:pem|key))(?:\/|$)/i.test(
          name,
        )
      ) {
        excluded.push(name);
        continue;
      }
      safePath(name);
      let file = root;
      for (const segment of name.split("/")) {
        file = path.join(file, segment);
        if (fs.lstatSync(file).isSymbolicLink())
          throw new WorkspaceError("SYMLINK_SCOPE_REJECTED");
      }
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw new WorkspaceError("SANDBOX_INPUT_INVALID");
      bytes += stat.size;
      if (bytes > 20 * 1024 * 1024)
        throw new WorkspaceError("SANDBOX_INPUT_TOO_LARGE");
      const content = fs.readFileSync(file),
        target = path.join(snapshot, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      files.push({
        path: name,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
    return { directory: snapshot, inputHash: hash(files), files, excluded };
  }
  async commit(runId: string, artifact: ImplementationArtifact) {
    const roots = await this.inspect(runId, artifact),
      candidates = [];
    for (const binding of artifact.bindings) {
      const root = roots.get(binding.repositoryId)!;
      const git = (args: string[]) =>
        workspaceGit(root, args, { runsRoot: this.policy.runsRoot });
      if (
        !artifact.diffs
          .find((d) => d.repositoryId === binding.repositoryId)
          ?.diff.trim()
      )
        continue;
      let head = await git(["rev-parse", "HEAD"]);
      if (head === binding.baseline) {
        await git([
          "-c",
          "user.name=Anka Document Workflow",
          "-c",
          "user.email=workspace@anka.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "Implement approved document units for " + runId,
        ]);
        head = await git(["rev-parse", "HEAD"]);
      }
      if (await git(["status", "--porcelain", "--untracked-files=all"]))
        throw new WorkspaceError("RUN_ARTIFACT_CHANGED");
      candidates.push({
        repositoryId: binding.repositoryId,
        baseline: binding.baseline,
        head,
        diffHash: hash(
          artifact.diffs.find((d) => d.repositoryId === binding.repositoryId)!
            .diff,
        ),
      });
    }
    return candidates;
  }
}
