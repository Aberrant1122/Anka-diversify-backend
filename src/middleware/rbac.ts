import { Request, Response, NextFunction } from "express";
import { prisma } from "../services/database";

// requireRole must run after authenticateToken (needs req.user.role from the JWT).
export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role) {
      return res.status(401).json({ message: "Authentication required" });
    }
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({ message: `Requires role: ${allowedRoles.join(" or ")}` });
    }
    next();
  };
}

let cachedRoleNames: Set<string> | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 60_000;

// Validates a role string against the Role registry (seeded via prisma/seed.ts),
// replacing the previous "any string is accepted" behavior on signup/invite/update.
export async function isValidRole(role: string): Promise<boolean> {
  const now = Date.now();
  if (!cachedRoleNames || now > cacheExpiresAt) {
    const roles = await prisma.role.findMany({ select: { name: true } });
    cachedRoleNames = new Set(roles.map((r) => r.name));
    cacheExpiresAt = now + CACHE_TTL_MS;
  }
  return cachedRoleNames.has(role);
}
