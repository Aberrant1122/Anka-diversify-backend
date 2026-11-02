import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../services/database";
import { JWT_SECRET } from "../config/env";
import { sessionVersion } from "../security/session-version";

// Extend Request interface to include user
declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

export const createAuthenticateToken =
  (database: Pick<typeof prisma, "user">) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];

      if (!token) {
        return res.status(401).json({ message: "No token provided" });
      }

      try {
        const decoded = jwt.verify(token, JWT_SECRET, {
          algorithms: ["HS256"],
        }) as jwt.JwtPayload;
        if (
          typeof decoded.userId !== "string" ||
          typeof decoded.sessionVersion !== "string"
        ) {
          return res
            .status(401)
            .json({ message: "Session expired; sign in again" });
        }
        const user = await database.user.findUnique({
          where: { id: decoded.userId },
          select: {
            id: true,
            email: true,
            role: true,
            status: true,
            password: true,
          },
        });
        if (
          !user ||
          user.status !== "active" ||
          decoded.sessionVersion !== sessionVersion(user)
        ) {
          return res
            .status(401)
            .json({ message: "Session expired; sign in again" });
        }
        req.user = { userId: user.id, email: user.email, role: user.role };

        next();
      } catch (error) {
        return res.status(401).json({ message: "Invalid token" });
      }
    } catch (error) {
      return res.status(500).json({ message: "Server error" });
    }
  };

export const authenticateToken = createAuthenticateToken(prisma);
export const requireAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  authenticateToken(req, res, next);
};
