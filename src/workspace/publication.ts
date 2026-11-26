import { PrismaClient } from "@prisma/client";
import { decrypt } from "../utils/encryption";
import { workspaceGit } from "./workspace-git";
import { WorkspaceError } from "./document-contract";
export interface PublicationTarget {
  repositoryId: string;
  remote: string;
  defaultBranch: string;
  branch: string;
  baseline: string;
  head: string;
  diffHash: string;
}
export interface PublicationReceipt {
  repositoryId: string;
  branch: string;
  head: string;
  status: "CREATED" | "ALREADY_PRESENT";
  url: string;
}
export interface PublicationAdapter {
  available(): boolean;
  publish(
    projectId: string,
    actor: string,
    workspace: string,
    target: PublicationTarget,
  ): Promise<PublicationReceipt>;
  lookup(
    projectId: string,
    actor: string,
    target: PublicationTarget,
  ): Promise<string | null>;
  evidenceClass: "GITHUB_BRANCH_PUBLICATION" | "CONTRACT_TEST";
}
export function githubRemote(value: string): string {
  const remote = value
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(remote))
    throw new WorkspaceError("PUBLICATION_TARGET_INVALID", 422);
  const parts = remote.slice("https://github.com/".length).split("/");
  if (parts.some((p) => p === "." || p === ".."))
    throw new WorkspaceError("PUBLICATION_TARGET_INVALID", 422);
  return remote;
}
export class GitBranchPublisher implements PublicationAdapter {
  readonly evidenceClass = "GITHUB_BRANCH_PUBLICATION" as const;
  constructor(
    private db: PrismaClient,
    private runsRoot: string,
    private enabled = process.env.ANKA_DOCUMENT_PUBLICATION_ENABLED === "true",
    private git = workspaceGit,
  ) {}
  available() {
    return this.enabled;
  }
  private async token(
    projectId: string,
    actor: string,
    target: PublicationTarget,
  ) {
    if (!this.enabled) throw new WorkspaceError("PUBLICATION_DISABLED", 503);
    if (
      !/^anka\/document-[a-f0-9-]{36}-[a-f0-9]{12}$/.test(target.branch) ||
      target.branch === target.defaultBranch ||
      !/^[-A-Za-z0-9_./]+$/.test(target.defaultBranch) ||
      target.defaultBranch.startsWith("-") ||
      target.defaultBranch.includes("..") ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target.head) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target.baseline)
    )
      throw new WorkspaceError("PUBLICATION_TARGET_INVALID");
    const repo = await this.db.projectRepository.findFirst({
      where: { id: target.repositoryId, projectId, project: { userId: actor } },
    });
    if (
      !repo ||
      githubRemote(repo.githubUrl) !== target.remote ||
      repo.defaultBranch !== target.defaultBranch
    )
      throw new WorkspaceError("PUBLICATION_TARGET_CHANGED");
    if (!repo.githubToken)
      throw new WorkspaceError("PUBLICATION_CREDENTIALS_REQUIRED", 503);
    return decrypt(repo.githubToken);
  }
  private async remoteHead(remote: string, branch: string, token: string) {
    const out = await this.git(
      this.runsRoot,
      ["ls-remote", "--refs", "--", remote, "refs/heads/" + branch],
      { runsRoot: this.runsRoot, token, timeoutMs: 15000 },
    );
    if (!out) return null;
    const lines = out.split("\n");
    if (lines.length !== 1)
      throw new WorkspaceError("REMOTE_REFERENCE_INVALID");
    const [head, ref] = lines[0].trim().split(/\s+/);
    if (
      ref !== "refs/heads/" + branch ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)
    )
      throw new WorkspaceError("REMOTE_REFERENCE_INVALID");
    return head;
  }
  async lookup(projectId: string, actor: string, target: PublicationTarget) {
    const token = await this.token(projectId, actor, target);
    return this.remoteHead(target.remote, target.branch, token);
  }
  async publish(
    projectId: string,
    actor: string,
    workspace: string,
    target: PublicationTarget,
  ) {
    const token = await this.token(projectId, actor, target);
    if (
      (await this.remoteHead(target.remote, target.defaultBranch, token)) !==
      target.baseline
    )
      throw new WorkspaceError("EXTERNAL_GIT_DRIFT");
    const existing = await this.remoteHead(target.remote, target.branch, token);
    if (existing && existing !== target.head)
      throw new WorkspaceError("PUBLICATION_BRANCH_CONFLICT");
    if (!existing) {
      // Atomic create-only lease. Never overwrite a branch, push tags, mutate
      // main, create/merge a PR, deploy, or accept a caller-supplied refspec.
      await this.git(
        workspace,
        [
          "-c",
          "push.followTags=false",
          "push",
          "--porcelain",
          "--force-with-lease=refs/heads/" + target.branch + ":",
          "--",
          target.remote,
          target.head + ":refs/heads/" + target.branch,
        ],
        { runsRoot: this.runsRoot, token, timeoutMs: 20000 },
      );
    }
    if (
      (await this.remoteHead(target.remote, target.branch, token)) !==
      target.head
    )
      throw new WorkspaceError("PUBLICATION_OUTCOME_UNCERTAIN");
    return {
      repositoryId: target.repositoryId,
      branch: target.branch,
      head: target.head,
      status: existing ? "ALREADY_PRESENT" : "CREATED",
      url: target.remote + "/tree/" + encodeURIComponent(target.branch),
    } as PublicationReceipt;
  }
}
