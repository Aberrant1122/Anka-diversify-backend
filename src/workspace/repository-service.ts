import fs from "fs";
import path from "path";
import os from "os";
import { PrismaClient } from "@prisma/client";
import { decrypt } from "../utils/encryption";
import { workspaceGit } from "./workspace-git";
import { WorkspaceError } from "./document-contract";
export const documentRepositoryRoot = () =>
  process.env.ANKA_REPOSITORY_ROOT ||
  path.join(os.tmpdir(), "anka-document-repositories");

// Owner-requested materialization populates a managed read/clone cache. It never
// runs repository code, resets an existing checkout, or approves documents.
export class WorkspaceRepositoryService {
  constructor(
    private db: PrismaClient,
    private root = documentRepositoryRoot(),
    private git = workspaceGit,
  ) {}
  async materialize(projectId: string, actor: string, repositoryId: string) {
    const repo = await this.db.projectRepository.findFirst({
      where: { id: repositoryId, projectId, project: { userId: actor } },
    });
    if (!repo) throw new WorkspaceError("PROJECT_RESOURCE_NOT_FOUND", 404);
    const remoteUrl = repo.githubUrl.replace(
      /^git@github\.com:/,
      "https://github.com/",
    );
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(projectId) ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(repo.id) ||
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(
        remoteUrl,
      ) ||
      !repo.defaultBranch ||
      !/^[-A-Za-z0-9_./]+$/.test(repo.defaultBranch) ||
      repo.defaultBranch.startsWith("-") ||
      repo.defaultBranch.includes("..")
    )
      throw new WorkspaceError("REPOSITORY_SOURCE_INVALID", 422);
    fs.mkdirSync(this.root, { recursive: true });
    const root = fs.realpathSync(this.root),
      projectRoot = path.join(root, projectId);
    fs.mkdirSync(projectRoot, { recursive: true });
    if (
      fs.lstatSync(projectRoot).isSymbolicLink() ||
      path.relative(root, fs.realpathSync(projectRoot)).startsWith("..")
    )
      throw new WorkspaceError("REPOSITORY_SCOPE_MISMATCH");
    const destination = path.join(projectRoot, repo.id);
    let exists = false;
    try {
      const stat = fs.lstatSync(destination);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new WorkspaceError("REPOSITORY_SCOPE_MISMATCH");
      exists = true;
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
    if (!exists) {
      // Credentials are transient Git configuration, never URL arguments or logs.
      const token = repo.githubToken ? decrypt(repo.githubToken) : undefined;
      await this.git(
        projectRoot,
        [
          "clone",
          "--no-checkout",
          "--single-branch",
          "--depth",
          "1",
          "--branch",
          repo.defaultBranch,
          "--",
          remoteUrl,
          destination,
        ],
        { runsRoot: root, token, timeoutMs: 120000 },
      );
      await this.git(
        destination,
        ["checkout", "--detach", "refs/remotes/origin/" + repo.defaultBranch],
        { runsRoot: root },
      );
    }
    if (
      fs.lstatSync(destination).isSymbolicLink() ||
      path.relative(root, fs.realpathSync(destination)).startsWith("..") ||
      !fs.lstatSync(path.join(destination, ".git")).isDirectory()
    )
      throw new WorkspaceError("REPOSITORY_SCOPE_MISMATCH");
    const config = fs.readFileSync(
      path.join(destination, ".git/config"),
      "utf8",
    );
    if (/^\s*\[(?:filter|include|includeIf)\b/im.test(config))
      throw new WorkspaceError("EXECUTABLE_GIT_CONFIG_REJECTED");
    const baseline = await this.git(destination, ["rev-parse", "HEAD"], {
      runsRoot: root,
    });
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline))
      throw new WorkspaceError("GIT_BASELINE_UNAVAILABLE");
    if (
      await this.git(
        destination,
        ["status", "--porcelain", "--untracked-files=all"],
        { runsRoot: root },
      )
    )
      throw new WorkspaceError("EXTERNAL_GIT_DRIFT");
    await this.db.projectRepository.update({
      where: { id: repo.id, projectId, project: { userId: actor } },
      data: { localPath: destination, currentIndexedCommit: baseline },
    });
    return { repositoryId: repo.id, baseline, materialized: true };
  }
}
