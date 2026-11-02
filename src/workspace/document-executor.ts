import fs from "fs";
import path from "path";
import os from "os";
import { workspaceGit } from "./workspace-git";
import { documentRepositoryRoot } from "./repository-service";
import { WorkspaceService } from "./workspace-service";
import { Unit, safePath, WorkspaceError, hash } from "./document-contract";

interface Change {
  repositoryId: string;
  path: string;
  action: "create" | "modify" | "delete";
  beforeHash: string | null;
  content: string | null;
}
export interface ExecutionPolicy {
  repositoryRoot: string;
  runsRoot: string;
}
export class DocumentExecutor {
  constructor(
    private service: WorkspaceService,
    private policy: ExecutionPolicy = {
      repositoryRoot: documentRepositoryRoot(),
      runsRoot:
        process.env.ANKA_EXECUTION_ROOT ||
        path.join(os.tmpdir(), "anka-document-runs"),
    },
  ) {}
  private git(cwd: string, args: string[]): Promise<string> {
    return workspaceGit(cwd, args, { runsRoot: this.policy.runsRoot });
  }
  private contained(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return (
      relative !== "" &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative)
    );
  }
  private source(localPath: string | null): string {
    if (!this.policy.repositoryRoot || !localPath)
      throw new WorkspaceError("MANAGED_REPOSITORY_ROOT_REQUIRED");
    const source = fs.realpathSync(localPath),
      allowed = fs.realpathSync(this.policy.repositoryRoot);
    if (!this.contained(allowed, source))
      throw new WorkspaceError("REPOSITORY_SCOPE_MISMATCH");
    const gitDir = path.join(source, ".git");
    if (
      !fs.lstatSync(gitDir).isDirectory() ||
      fs.lstatSync(gitDir).isSymbolicLink()
    )
      throw new WorkspaceError("MANAGED_CLONE_REQUIRED");
    // A clean/status check can invoke configured Git filters. Never run it on
    // a source clone that supplies executable filters or includes other config.
    const config = fs.readFileSync(path.join(gitDir, "config"), "utf8");
    if (/^\s*\[(?:filter|include|includeIf)\b/im.test(config))
      throw new WorkspaceError("EXECUTABLE_GIT_CONFIG_REJECTED");
    return source;
  }
  private file(root: string, name: string): string {
    const parts = safePath(name).split("/");
    let target = root;
    for (const part of parts) {
      target = path.join(target, part);
      try {
        if (fs.lstatSync(target).isSymbolicLink())
          throw new WorkspaceError("SYMLINK_SCOPE_REJECTED");
      } catch (e: any) {
        if (e?.code !== "ENOENT") throw e;
      }
    }
    if (!this.contained(root, target))
      throw new WorkspaceError("SCOPE_PATH_INVALID");
    return target;
  }
  async observedBaselines(
    repositories: { id: string; localPath: string | null }[],
  ) {
    return Promise.all(
      repositories.map(async (repository) => {
        try {
          const source = this.source(repository.localPath);
          const head = await this.git(source, ["rev-parse", "HEAD"]);
          const dirty = await this.git(source, [
            "status",
            "--porcelain",
            "--untracked-files=all",
          ]);
          return {
            repositoryId: repository.id,
            head,
            clean: !dirty,
            error: null,
          };
        } catch (e) {
          return {
            repositoryId: repository.id,
            head: null,
            clean: false,
            error:
              e instanceof WorkspaceError
                ? e.code
                : "REPOSITORY_NOT_MATERIALIZED",
          };
        }
      }),
    );
  }
  async preview(
    projectId: string,
    actor: string,
    runId: string,
    repositories: { id: string; localPath: string | null }[],
  ) {
    const run = await this.service.assertRunnable(projectId, actor, runId);
    const authority = run.authority as any;
    const changes: Change[] = [];
    for (const unit of authority.units as Unit[]) {
      const source = this.source(
        repositories.find((r) => r.id === unit.repositoryId)?.localPath ?? null,
      );
      const baseline = authority.repositories.find(
        (r: any) => r.id === unit.repositoryId,
      )?.baseline;
      if (
        (await this.git(source, ["rev-parse", "HEAD"])) !== baseline ||
        (await this.git(source, [
          "status",
          "--porcelain",
          "--untracked-files=all",
        ]))
      )
        throw new WorkspaceError("EXTERNAL_GIT_DRIFT");
      for (const file of unit.files) {
        const target = this.file(source, file.path);
        const content = fs.existsSync(target)
          ? fs.readFileSync(target, "utf8")
          : null;
        changes.push({
          repositoryId: unit.repositoryId,
          ...file,
          beforeHash: content === null ? null : hash(content),
          content: file.action === "delete" ? null : (content ?? ""),
        });
      }
    }
    return changes;
  }
  async execute(
    projectId: string,
    actor: string,
    runId: string,
    changes: Change[],
    repositories: { id: string; localPath: string | null }[],
  ) {
    if (
      !Array.isArray(changes) ||
      !changes.length ||
      changes.length > 50 ||
      Buffer.byteLength(JSON.stringify(changes)) > 1000000
    )
      throw new WorkspaceError("CHANGE_SET_INVALID", 422);
    try {
      return await this.service.executeWithAuthority(
        projectId,
        actor,
        runId,
        async (run) => {
          const authority = run.authority;
          const scope = (authority.units as Unit[]).flatMap((u) =>
            u.files.map((f) => ({ ...f, repositoryId: u.repositoryId })),
          );
          const seen = new Set<string>();
          for (const c of changes) {
            const key = c.repositoryId + ":" + safePath(c.path).toLowerCase();
            if (
              seen.has(key) ||
              !scope.some(
                (s) =>
                  s.repositoryId === c.repositoryId &&
                  s.path === c.path &&
                  s.action === c.action,
              ) ||
              (c.action === "delete"
                ? c.content !== null
                : typeof c.content !== "string") ||
              (c.beforeHash !== null &&
                !/^[a-f0-9]{64}$/.test(c.beforeHash ?? ""))
            )
              throw new WorkspaceError("SCOPE_CHANGE_REQUIRED");
            seen.add(key);
          }
          if (
            !this.policy.repositoryRoot ||
            !fs.existsSync(this.policy.repositoryRoot)
          )
            throw new WorkspaceError("MANAGED_REPOSITORY_ROOT_REQUIRED");
          const allowed = fs.realpathSync(this.policy.repositoryRoot);
          fs.mkdirSync(this.policy.runsRoot, { recursive: true });
          const runRoot = path.join(
            fs.realpathSync(this.policy.runsRoot),
            run.id,
          );
          if (fs.existsSync(runRoot))
            throw new WorkspaceError("RUN_WORKSPACE_EXISTS");
          fs.mkdirSync(runRoot);
          const roots = new Map<string, string>();
          const bindings: object[] = [];
          // Preflight every repository before modifying any isolated copy.
          const selected = [
            ...new Set((authority.units as Unit[]).map((u) => u.repositoryId)),
          ];
          for (const id of selected) {
            const repo = repositories.find((r) => r.id === id);
            const baseline = authority.repositories.find(
              (r: any) => r.id === id,
            )?.baseline;
            if (!repo?.localPath || !baseline)
              throw new WorkspaceError("REPOSITORY_NOT_MATERIALIZED");
            const source = this.source(repo.localPath);
            if (
              !this.contained(allowed, source) ||
              (await this.git(source, ["rev-parse", "HEAD"])) !== baseline ||
              (await this.git(source, [
                "status",
                "--porcelain",
                "--untracked-files=all",
              ]))
            )
              throw new WorkspaceError("EXTERNAL_GIT_DRIFT");
            const dest = path.join(runRoot, String(roots.size));
            await this.git(runRoot, [
              "clone",
              "--no-local",
              "--no-checkout",
              "--",
              source,
              dest,
            ]);
            await this.git(dest, ["checkout", "--detach", baseline]);
            roots.set(id, dest);
            bindings.push({ repositoryId: id, baseline, workspace: dest });
          }
          // Verify all preimages first so a mismatch cannot partially apply a batch.
          for (const c of changes) {
            const root = roots.get(c.repositoryId);
            if (!root) throw new WorkspaceError("REPOSITORY_SCOPE_MISMATCH");
            const target = this.file(root, c.path);
            const exists = fs.existsSync(target);
            if (exists && !fs.statSync(target).isFile())
              throw new WorkspaceError("FILE_PREIMAGE_MISMATCH");
            if (
              c.action === "create"
                ? exists || c.beforeHash !== null
                : !exists ||
                  hash(fs.readFileSync(target, "utf8")) !== c.beforeHash
            )
              throw new WorkspaceError("FILE_PREIMAGE_MISMATCH");
          }
          for (const c of changes) {
            const target = this.file(roots.get(c.repositoryId)!, c.path);
            if (c.action === "delete") fs.unlinkSync(target);
            else {
              fs.mkdirSync(path.dirname(target), { recursive: true });
              fs.writeFileSync(target, c.content!, "utf8");
            }
          }
          const diffs = [];
          for (const [id, root] of roots) {
            // Include newly created files in a reviewable diff without a commit.
            // Stage only the explicitly approved paths. An approved creation
            // may match .gitignore; it must still appear in its reviewed diff.
            await this.git(root, [
              "add",
              "--all",
              "--force",
              "--",
              ...changes
                .filter((c) => c.repositoryId === id)
                .map((c) => c.path),
            ]);
            diffs.push({
              repositoryId: id,
              diff: await this.git(root, [
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-textconv",
                "--binary",
              ]),
            });
          }
          const checks = (authority.units as Unit[]).flatMap((unit) =>
            unit.checks.map((check) => {
              const root = roots.get(unit.repositoryId)!;
              let passed = false;
              try {
                const target = this.file(root, check.path);
                if (check.type === "absent") {
                  passed = !fs.existsSync(target);
                } else {
                  const content = fs.readFileSync(target, "utf8");
                  if (check.type === "contains")
                    passed = content.includes(check.expected);
                  else if (check.type === "not_contains")
                    passed = !content.includes(check.expected);
                  else {
                    JSON.parse(content);
                    passed = true;
                  }
                }
              } catch {}
              return {
                unitId: unit.id,
                requirementIds: unit.requirementIds,
                criterionId: check.criterionId,
                checkId: check.id,
                type: check.type,
                passed,
              };
            }),
          );
          return {
            bindings,
            diffs,
            checks,
            unitIds: authority.unitIds,
            architectureHash: authority.architectureHash,
            changeHash: hash(changes),
            implemented: true,
            verification: checks.every((c) => c.passed)
              ? "CHECKS_PASSED"
              : "CHECKS_FAILED",
          };
        },
      );
    } catch (e: any) {
      if (
        e instanceof WorkspaceError &&
        ![
          "RUN_ALREADY_ATTEMPTED",
          "RUN_NOT_FOUND",
          "AUTHORITY_SUPERSEDED",
        ].includes(e.code)
      )
        await this.service
          .record(
            projectId,
            actor,
            runId,
            e.code === "SCOPE_CHANGE_REQUIRED"
              ? "SCOPE_CHANGE_REQUIRED"
              : "RUN_FAILED",
            { code: e.code },
          )
          .catch(() => {});
      throw e;
    }
  }
}
