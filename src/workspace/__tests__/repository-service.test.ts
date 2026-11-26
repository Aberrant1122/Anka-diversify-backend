import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { WorkspaceRepositoryService } from "../repository-service";
import { workspaceGit } from "../workspace-git";

describe("managed repository materialization", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anka-materialize-test-"));
  const source = path.join(root, "source"),
    managed = path.join(root, "managed");
  let baseline: string;
  const repo = {
    id: "repo",
    projectId: "p",
    githubUrl: "https://github.com/example/synthetic.git",
    defaultBranch: "main",
    githubToken: null,
  };
  const database = {
    projectRepository: { findFirst: jest.fn(), update: jest.fn() },
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Synthetic Test",
        "-c",
        "user.email=synthetic@example.test",
        ...args,
      ],
      { cwd, encoding: "utf8" },
    ).trim();
  const service = new WorkspaceRepositoryService(
    database as any,
    managed,
    async (cwd, args, options) => {
      // Only redirect this test's registered remote to its synthetic local source.
      const localArgs = args.map((a) => (a === repo.githubUrl ? source : a));
      return workspaceGit(cwd, localArgs, options);
    },
  );
  beforeAll(() => {
    fs.mkdirSync(source);
    git(source, "init", "-b", "main");
    fs.writeFileSync(path.join(source, "README.md"), "original\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "synthetic baseline");
    baseline = git(source, "rev-parse", "HEAD");
  });
  beforeEach(() => {
    jest.clearAllMocks();
    database.projectRepository.findFirst.mockResolvedValue(repo);
  });
  it("checks owner binding before creating a clone", async () => {
    database.projectRepository.findFirst.mockResolvedValue(null);
    await expect(
      service.materialize("p", "other", "repo"),
    ).rejects.toMatchObject({ code: "PROJECT_RESOURCE_NOT_FOUND" });
    expect(database.projectRepository.findFirst).toHaveBeenCalledWith({
      where: { id: "repo", projectId: "p", project: { userId: "other" } },
    });
    expect(fs.existsSync(managed)).toBe(false);
  });
  it("registers a clean exact baseline and reuses it without resetting", async () => {
    expect(await service.materialize("p", "owner", "repo")).toEqual({
      repositoryId: "repo",
      baseline,
      materialized: true,
    });
    expect(database.projectRepository.update).toHaveBeenCalledWith({
      where: { id: "repo", projectId: "p", project: { userId: "owner" } },
      data: {
        localPath: path.join(managed, "p", "repo"),
        currentIndexedCommit: baseline,
      },
    });
    expect(await service.materialize("p", "owner", "repo")).toMatchObject({
      baseline,
    });
    fs.writeFileSync(
      path.join(managed, "p", "repo", "README.md"),
      "local drift\n",
    );
    await expect(
      service.materialize("p", "owner", "repo"),
    ).rejects.toMatchObject({ code: "EXTERNAL_GIT_DRIFT" });
    expect(
      fs.readFileSync(path.join(managed, "p", "repo", "README.md"), "utf8"),
    ).toBe("local drift\n");
  }, 30000);
  it("rejects a non-GitHub source before invoking Git", async () => {
    database.projectRepository.findFirst.mockResolvedValue({
      ...repo,
      githubUrl: "file:///private/source",
    });
    await expect(
      service.materialize("p", "owner", "repo"),
    ).rejects.toMatchObject({ code: "REPOSITORY_SOURCE_INVALID" });
    expect(database.projectRepository.update).not.toHaveBeenCalled();
  });
});
