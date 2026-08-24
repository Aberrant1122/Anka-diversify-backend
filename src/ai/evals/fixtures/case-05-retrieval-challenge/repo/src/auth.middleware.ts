export function authMiddleware(req: any, res: any, next: any) {
  const authHeader = req.headers?.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
