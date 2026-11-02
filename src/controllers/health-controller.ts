import { Request, Response } from "express";
import { prisma } from "../services/database";

export async function healthCheck(_req: Request, res: Response): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.workspaceHead.findFirst({select:{projectId:true,stateVersion:true,mainId:true,architectureId:true,approvalId:true}});
    await prisma.workspaceOperation.findFirst({select:{id:true,status:true,inputHash:true}});
    res.json({ status: "OK", timestamp: new Date().toISOString(), version: "1.0.0" });
  } catch {
    res.status(503).json({ status: "UNAVAILABLE" });
  }
}
