import fs from "fs";
import path from "path";
import { scanDirectoryFiles, mergeFilesWithDiskPriority } from "../../services/repository-tool.engine";
import { RepositorySnapshotData } from "./RepositorySnapshot";

export class RepositoryScanner {
  static async ensureLocalWorkspace(
    projectId: string,
    localPath?: string | null,
    snapshot?: any,
  ): Promise<string | null> {
    const cwd = process.cwd();
    const isBackendSelfPath = localPath
      ? path.resolve(localPath) === path.resolve(cwd) || localPath.includes("anka-os-backend")
      : false;
    if (localPath && fs.existsSync(localPath) && !isBackendSelfPath) return localPath;

    const fileList: Array<{ path: string; content?: string }> = Array.isArray(snapshot)
      ? snapshot
      : snapshot?.keyFiles || snapshot?.repoSnapshot || [];

    if (!fileList || fileList.length === 0) return !isBackendSelfPath ? localPath || null : null;

    try {
      const cacheDir = path.join(cwd, ".anka-cache", "projects", projectId);
      await fs.promises.mkdir(cacheDir, { recursive: true });

      for (const item of fileList) {
        if (item.path && typeof item.content === "string") {
          const abs = path.join(cacheDir, item.path);
          await fs.promises.mkdir(path.dirname(abs), { recursive: true });
          await fs.promises.writeFile(abs, item.content, "utf8");
        }
      }
      return cacheDir;
    } catch {
      return !isBackendSelfPath ? localPath || null : null;
    }
  }

  static getEffectiveSnapshot(snapshot: any, localPath?: string | null): RepositorySnapshotData {
    const cwd = process.cwd();
    const isBackendSelfPath = localPath
      ? path.resolve(localPath) === path.resolve(cwd) || localPath.includes("anka-os-backend")
      : false;

    // Collect candidate disk directories (skip if this is the backend's own path).
    const candidateDirs: string[] = [];
    if (localPath && !isBackendSelfPath && fs.existsSync(localPath)) {
      candidateDirs.push(localPath);
    }

    // Collect snapshot entries for fallback.
    const snapshotList: Array<{ path: string; content: string }> = [];
    if (snapshot) {
      const list = Array.isArray(snapshot) ? snapshot : snapshot.keyFiles || snapshot.repoSnapshot || [];
      for (const f of list) {
        if (f && f.path && typeof f.content === "string") {
          snapshotList.push({ path: f.path, content: f.content });
        }
      }
    }

    // Disk files win; snapshot is fallback for remote-only paths.
    const mergedList = mergeFilesWithDiskPriority(candidateDirs, snapshotList);

    return {
      repoName: snapshot?.repoName || "workspace",
      defaultBranch: snapshot?.defaultBranch || "main",
      description: snapshot?.description || "",
      languages: snapshot?.languages || { TypeScript: mergedList.length },
      fileTree: mergedList.map((f) => f.path),
      keyFiles: mergedList,
      lastSyncedAt: snapshot?.lastSyncedAt || new Date(),
    };
  }
}
