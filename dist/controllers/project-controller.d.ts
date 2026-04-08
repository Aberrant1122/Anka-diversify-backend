import { Request, Response } from "express";
export declare class ProjectController {
    getProjects(req: Request, res: Response): Promise<void>;
    getProjectById(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    createProject(req: Request, res: Response): Promise<void>;
    updateProject(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    deleteProject(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    syncGithub(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    getProjectTasks(req: Request, res: Response): Promise<void>;
    createTask(req: Request, res: Response): Promise<void>;
    updateTask(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    deleteTask(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
}
//# sourceMappingURL=project-controller.d.ts.map