export interface RepositorySnapshotData {
  repoName: string;
  defaultBranch: string;
  description?: string;
  languages: Record<string, number>;
  fileTree: string[];
  keyFiles: Array<{ path: string; content?: string }>;
  lastSyncedAt: Date;
}
