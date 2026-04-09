export declare class ProjectService {
    getAllProjects(userId?: string): Promise<({
        memorySummary: {
            summary: string;
            lastUpdated: Date;
        } | null;
        repoSnapshot: {
            repoName: string;
            lastSyncedAt: Date;
            githubUrl: string;
        } | null;
        tasks: {
            priority: string;
            description: string | null;
            id: string;
            projectId: string;
            phase: string;
            status: string;
            dueDate: Date | null;
            createdAt: Date;
            updatedAt: Date;
            title: string;
        }[];
    } & {
        priority: string;
        description: string | null;
        id: string;
        githubUrl: string | null;
        name: string;
        phase: string | null;
        progress: number;
        teamSize: number;
        status: string;
        startDate: Date;
        dueDate: Date | null;
        userId: string;
        createdAt: Date;
        updatedAt: Date;
    })[]>;
    getProjectById(id: string, userId?: string): Promise<({
        memorySummary: {
            id: string;
            projectId: string;
            summary: string;
            lastUpdated: Date;
            version: number;
        } | null;
        repoSnapshot: {
            languages: string;
            repoName: string;
            defaultBranch: string;
            fileTree: string;
            keyFiles: string;
            description: string;
            lastSyncedAt: Date;
            id: string;
            projectId: string;
            githubUrl: string;
        } | null;
        decisions: {
            description: string;
            id: string;
            projectId: string;
            title: string;
            impact: string | null;
            madeAt: Date;
            madeBy: string | null;
        }[];
        rules: {
            priority: string;
            description: string;
            id: string;
            projectId: string;
            createdAt: Date;
            title: string;
        }[];
        tasks: {
            priority: string;
            description: string | null;
            id: string;
            projectId: string;
            phase: string;
            status: string;
            dueDate: Date | null;
            createdAt: Date;
            updatedAt: Date;
            title: string;
        }[];
    } & {
        priority: string;
        description: string | null;
        id: string;
        githubUrl: string | null;
        name: string;
        phase: string | null;
        progress: number;
        teamSize: number;
        status: string;
        startDate: Date;
        dueDate: Date | null;
        userId: string;
        createdAt: Date;
        updatedAt: Date;
    }) | null>;
    createProject(data: {
        name: string;
        description?: string;
        phase?: string;
        priority?: string;
        githubUrl?: string;
        startDate?: string;
        dueDate?: string;
        status?: string;
    }, userId?: string): Promise<{
        priority: string;
        description: string | null;
        id: string;
        githubUrl: string | null;
        name: string;
        phase: string | null;
        progress: number;
        teamSize: number;
        status: string;
        startDate: Date;
        dueDate: Date | null;
        userId: string;
        createdAt: Date;
        updatedAt: Date;
    }>;
    updateProject(id: string, data: {
        name?: string;
        description?: string;
        phase?: string;
        priority?: string;
        githubUrl?: string;
        status?: string;
        progress?: number;
        dueDate?: string;
    }, userId?: string): Promise<{
        priority: string;
        description: string | null;
        id: string;
        githubUrl: string | null;
        name: string;
        phase: string | null;
        progress: number;
        teamSize: number;
        status: string;
        startDate: Date;
        dueDate: Date | null;
        userId: string;
        createdAt: Date;
        updatedAt: Date;
    } | null>;
    deleteProject(id: string, userId?: string): Promise<boolean>;
    getProjectTasks(projectId: string, userId?: string): Promise<{
        priority: string;
        description: string | null;
        id: string;
        projectId: string;
        phase: string;
        status: string;
        dueDate: Date | null;
        createdAt: Date;
        updatedAt: Date;
        title: string;
    }[]>;
    createTask(data: {
        project_id: string;
        title: string;
        description?: string;
        status?: string;
        priority?: string;
        phase?: string;
        due_date?: string;
    }): Promise<{
        priority: string;
        description: string | null;
        id: string;
        projectId: string;
        phase: string;
        status: string;
        dueDate: Date | null;
        createdAt: Date;
        updatedAt: Date;
        title: string;
    }>;
    updateTask(taskId: string, data: {
        title?: string;
        description?: string;
        status?: string;
        priority?: string;
        phase?: string;
        dueDate?: string;
    }): Promise<{
        priority: string;
        description: string | null;
        id: string;
        projectId: string;
        phase: string;
        status: string;
        dueDate: Date | null;
        createdAt: Date;
        updatedAt: Date;
        title: string;
    }>;
    deleteTask(taskId: string): Promise<boolean>;
    getProjectFiles(projectId: string): Promise<{
        id: string;
        projectId: string;
        name: string;
        phase: string;
        createdAt: Date;
        updatedAt: Date;
        type: string;
        url: string | null;
        s3Key: string | null;
        size: string | null;
        uploadedBy: string | null;
    }[]>;
    createFile(data: {
        projectId: string;
        name: string;
        type?: string;
        phase?: string;
        url?: string;
        s3Key?: string;
        size?: string;
        uploadedBy?: string;
    }): Promise<{
        id: string;
        projectId: string;
        name: string;
        phase: string;
        createdAt: Date;
        updatedAt: Date;
        type: string;
        url: string | null;
        s3Key: string | null;
        size: string | null;
        uploadedBy: string | null;
    }>;
    deleteFile(fileId: string): Promise<string | null>;
}
//# sourceMappingURL=project-service.d.ts.map