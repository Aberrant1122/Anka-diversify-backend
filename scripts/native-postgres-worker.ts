import { PrismaClient } from "@prisma/client";
import { WorkspaceService } from "../src/workspace/workspace-service";
import { mainFromBrief } from "../src/workspace/document-contract";
import readline from "readline";
(async () => {
  const db = new PrismaClient({
    datasources: { db: { url: process.env.ANKA_REHEARSAL_DATABASE_URL } },
  });
  try {
    const [{ pid }] = await db.$queryRawUnsafe<{ pid: number }[]>(
      "SELECT pg_backend_pid() AS pid",
    );
    console.log(JSON.stringify({ ready: true, pid }));
    await new Promise<void>((resolve) =>
      readline
        .createInterface({ input: process.stdin })
        .once("line", () => resolve()),
    );
    try {
      await new WorkspaceService(db).save("project", "owner", {
        kind: "MAIN",
        content: mainFromBrief("Native concurrency note"),
        expectedVersion: 0,
        reason: "Synthetic native process race",
      });
      console.log(JSON.stringify({ outcome: "SAVED" }));
    } catch (e: any) {
      if (e.code !== "STATE_CONFLICT") throw e;
      console.log(JSON.stringify({ outcome: "STATE_CONFLICT" }));
    }
  } finally {
    await db.$disconnect();
  }
})().catch(() => {
  console.error("Native rehearsal worker failed");
  process.exitCode = 1;
});
