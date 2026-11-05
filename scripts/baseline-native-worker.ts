import { PrismaClient } from "@prisma/client";
import { BaselineValidationService } from "../src/workspace/baseline-validation-service";
import { baselineDocuments } from "../src/workspace/__tests__/baseline-fixture";
import readline from "readline";
(async () => {
  const url = new URL(process.env.ANKA_REHEARSAL_DATABASE_URL || "");
  if (
    process.env.ANKA_LOCAL_REHEARSAL !== "1" ||
    url.hostname !== "127.0.0.1" ||
    url.protocol !== "postgresql:" ||
    url.username !== "anka_rehearsal" ||
    url.password !== "synthetic" ||
    url.pathname !== "/anka_rehearsal" ||
    !/^anka_rehearsal_[a-f0-9]{32}$/.test(
      url.searchParams.get("schema") || "",
    ) ||
    [...url.searchParams.keys()].some(
      (k) => !["schema", "connection_limit"].includes(k),
    )
  )
    throw Error("Synthetic scoped loopback only");
  const db = new PrismaClient({ datasources: { db: { url: url.href } } });
  try {
    if (process.argv[2] === "setup") {
      const f = await baselineDocuments(db, "project", "owner");
      console.log(JSON.stringify(f.claimInput));
      return;
    }
    const request = JSON.parse(process.env.ANKA_BASELINE_CLAIM || "{}");
    if (process.env.ANKA_BASELINE_RACE_VARIANT === "different-key")
      request.idempotencyKey += "-" + process.env.ANKA_BASELINE_WORKER_INDEX;
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
      const result = await new BaselineValidationService(db).claim(
        "project",
        "owner",
        request,
      );
      console.log(
        JSON.stringify({
          outcome: result.reused ? "REUSED" : "CLAIMED",
          operationId: result.operation.id,
        }),
      );
    } catch (e: any) {
      if (
        !["STATE_CONFLICT", "BASELINE_OPERATION_ALREADY_CLAIMED"].includes(
          e.code,
        )
      )
        throw e;
      console.log(JSON.stringify({ outcome: e.code }));
    }
  } finally {
    await db.$disconnect();
  }
})().catch(() => {
  console.error("Native baseline rehearsal worker failed");
  process.exitCode = 1;
});
