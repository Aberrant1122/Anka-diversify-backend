import { GitBranchPublisher, PublicationTarget } from "../publication";
import { encrypt } from "../../utils/encryption";
const target: PublicationTarget = {
  repositoryId: "repo",
  remote: "https://github.com/example/synthetic",
  defaultBranch: "main",
  branch: "anka/document-12345678-1234-1234-1234-123456789abc-123456789abc",
  baseline: "a".repeat(40),
  head: "b".repeat(40),
  diffHash: "c".repeat(64),
};
const repo = {
  id: "repo",
  githubUrl: target.remote,
  defaultBranch: "main",
  githubToken: encrypt("synthetic-not-a-real-token"),
};
describe("create-only publication adapter contract (Git transport is injected)", () => {
  let calls: { cwd: string; args: string[]; options: any }[],
    branch: string | null,
    db: any,
    git: any;
  beforeEach(() => {
    calls = [];
    branch = null;
    db = {
      projectRepository: { findFirst: jest.fn().mockResolvedValue(repo) },
    };
    git = jest.fn(async (cwd, args, options) => {
      calls.push({ cwd, args, options });
      if (args.includes("ls-remote")) {
        const ref = args[args.length - 1];
        return ref === "refs/heads/main"
          ? target.baseline + "\t" + ref
          : branch
            ? branch + "\t" + ref
            : "";
      }
      if (args.includes("push")) {
        branch = target.head;
        return "created";
      }
      throw Error("Unexpected Git command");
    });
  });
  it("performs no remote access while disabled", async () => {
    const p = new GitBranchPublisher(db, "managed", false, git);
    await expect(p.publish("p", "owner", "run", target)).rejects.toMatchObject({
      code: "PUBLICATION_DISABLED",
    });
    expect(git).not.toHaveBeenCalled();
  });
  it("creates only the exact approved branch with an absent-ref lease", async () => {
    const p = new GitBranchPublisher(db, "managed", true, git);
    expect(await p.publish("p", "owner", "run", target)).toMatchObject({
      status: "CREATED",
      head: target.head,
    });
    const push = calls.find((c) => c.args.includes("push"))!;
    expect(push.args).toContain(
      "--force-with-lease=refs/heads/" + target.branch + ":",
    );
    expect(push.args[push.args.length - 1]).toBe(
      target.head + ":refs/heads/" + target.branch,
    );
    expect(push.args).toContain("push.followTags=false");
    expect(push.args.join(" ")).not.toContain("synthetic-not-a-real-token");
    expect(push.options.token).toBe("synthetic-not-a-real-token");
    expect(push.args).not.toContain("--force");
  });
  it("does not push again when the exact branch already exists", async () => {
    branch = target.head;
    expect(
      await new GitBranchPublisher(db, "managed", true, git).publish(
        "p",
        "owner",
        "run",
        target,
      ),
    ).toMatchObject({ status: "ALREADY_PRESENT" });
    expect(calls.some((c) => c.args.includes("push"))).toBe(false);
  });
  it("never overwrites a conflicting branch", async () => {
    branch = "d".repeat(40);
    await expect(
      new GitBranchPublisher(db, "managed", true, git).publish(
        "p",
        "owner",
        "run",
        target,
      ),
    ).rejects.toMatchObject({ code: "PUBLICATION_BRANCH_CONFLICT" });
    expect(calls.some((c) => c.args.includes("push"))).toBe(false);
  });
  it("blocks default-branch drift before a write", async () => {
    git.mockImplementation(async () => "d".repeat(40) + "\trefs/heads/main");
    await expect(
      new GitBranchPublisher(db, "managed", true, git).publish(
        "p",
        "owner",
        "run",
        target,
      ),
    ).rejects.toMatchObject({ code: "EXTERNAL_GIT_DRIFT" });
  });
  it.each(["main", "../main", "refs/heads/main"])(
    "rejects an unapproved target ref %s",
    async (branch) => {
      await expect(
        new GitBranchPublisher(db, "managed", true, git).publish(
          "p",
          "owner",
          "run",
          { ...target, branch },
        ),
      ).rejects.toMatchObject({ code: "PUBLICATION_TARGET_INVALID" });
      expect(git).not.toHaveBeenCalled();
    },
  );
  it("binds encrypted credentials and repository identity to the current owner", async () => {
    db.projectRepository.findFirst.mockResolvedValue(null);
    await expect(
      new GitBranchPublisher(db, "managed", true, git).publish(
        "p",
        "other",
        "run",
        target,
      ),
    ).rejects.toMatchObject({ code: "PUBLICATION_TARGET_CHANGED" });
    expect(db.projectRepository.findFirst).toHaveBeenCalledWith({
      where: { id: "repo", projectId: "p", project: { userId: "other" } },
    });
    expect(git).not.toHaveBeenCalled();
  });
});
