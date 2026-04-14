import { Request, Response } from "express";
export declare class InviteController {
    createInvite(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    listInvites(req: Request, res: Response): Promise<void>;
    revokeInvite(req: Request, res: Response): Promise<void>;
    validateToken(req: Request, res: Response): Promise<void>;
    acceptInvite(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    listUsers(req: Request, res: Response): Promise<void>;
    updateUser(req: Request, res: Response): Promise<void>;
    removeUser(req: Request, res: Response): Promise<void>;
}
//# sourceMappingURL=invite-controller.d.ts.map