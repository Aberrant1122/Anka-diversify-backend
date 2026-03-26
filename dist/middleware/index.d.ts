import { Request, Response, NextFunction } from 'express';
export declare const errorHandler: (err: Error, req: Request, res: Response, next: NextFunction) => void;
export declare const requestLogger: (req: Request, res: Response, next: NextFunction) => void;
export declare const corsHandler: (req: Request, res: Response, next: NextFunction) => void;
//# sourceMappingURL=index.d.ts.map