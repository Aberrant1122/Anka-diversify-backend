import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../services/database";

const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret";

// Extend Request interface to include user
declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

export const authenticateToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;

      // Attach user info to request
      req.user = decoded;

      next();
    } catch (error) {
      return res.status(401).json({ message: "Invalid token" });
    }
  } catch (error) {
    return res.status(500).json({ message: "Server error" });
  }
};

export const requireAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  authenticateToken(req, res, next);
};
