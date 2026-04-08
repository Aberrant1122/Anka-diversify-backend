interface RepoFile {
    path: string;
    content: string;
}
export interface RepoSnapshot {
    repoName: string;
    defaultBranch: string;
    description: string;
    languages: Record<string, number>;
    fileTree: string[];
    keyFiles: RepoFile[];
    lastSyncedAt: Date;
}
export declare function fetchRepoSnapshot(githubUrl: string): Promise<RepoSnapshot>;
export declare class ProjectGitHubService {
    static buildProjectContext(projectId: string, githubUrl: string): Promise<void>;
    static getSnapshot(projectId: string): Promise<RepoSnapshot | null>;
}
export {};
//# sourceMappingURL=github.service.d.ts.map