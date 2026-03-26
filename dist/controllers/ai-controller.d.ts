import { Request, Response } from "express";
export declare class AiController {
    generalChat(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    getGeneralSessions(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    getGeneralSessionMessages(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    projectChat(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    getProjectSessions(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    getProjectSessionMessages(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    getProjectContext(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
}
//# sourceMappingURL=ai-controller.d.ts.map