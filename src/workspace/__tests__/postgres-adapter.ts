import { randomUUID } from "crypto";

// Test-only Prisma-shaped adapter over a real isolated embedded Postgres engine.
// It implements the small delegate surface used by WorkspaceService; production
// always uses PrismaClient. Database constraints/triggers execute unchanged.
const tables: Record<string, string> = {
  project: "projects",
  user: "users",
  projectRepository: "project_repositories",
  phaseArtifact: "phase_artifacts",
  projectDocument: "project_documents",
  workspaceDocument: "WorkspaceDocument",
  workspaceHead: "WorkspaceHead",
  workspaceApproval: "WorkspaceApproval",
  workspaceRun: "WorkspaceRun",
  workspaceEvent: "WorkspaceEvent",
  workspaceOperation: "WorkspaceOperation",
};
const jsonFields = new Set([
  "content",
  "snapshot",
  "authority",
  "payload",
  "context",
  "result",
]);
const quote = (v: string) => '"' + v.replace(/"/g, '""') + '"';
export function postgresAdapter(db: any): any {
  const adapter: any = {};
  for (const [key, table] of Object.entries(tables)) {
    const query = async (args: any = {}) => {
      const values: any[] = [];
      const where = (input: any): string =>
        Object.entries(input ?? {})
          .flatMap(([field, value]: any): string[] => {
            if (value === undefined) return [];
            if (field === "project") {
              values.push(value.userId);
              return [
                '"projectId" IN (SELECT id FROM projects WHERE "userId" = $' +
                  values.length +
                  ")",
              ];
            }
            if (field === "user" && value?.status) {
              values.push(value.status);
              return [
                '"userId" IN (SELECT id FROM users WHERE status=$' +
                  values.length +
                  ")",
              ];
            }
            if (
              field === "projectId_idempotencyKey" ||
              field === "projectId_kind_idempotencyKey"
            )
              return [where(value)];
            if (value && typeof value === "object" && "in" in value) {
              values.push(value.in);
              return [quote(field) + " = ANY($" + values.length + ")"];
            }
            if (value === null) return [quote(field) + " IS NULL"];
            values.push(value);
            return [quote(field) + " = $" + values.length];
          })
          .join(" AND ") || "true";
      const condition = where(args.where);
      const order = args.orderBy
        ? " ORDER BY " +
          Object.entries(args.orderBy)
            .map(
              ([field, dir]) =>
                quote(field) + " " + (dir === "desc" ? "DESC" : "ASC"),
            )
            .join(",")
        : "";
      return (
        await db.query(
          "SELECT * FROM " + quote(table) + " WHERE " + condition + order,
          values,
        )
      ).rows;
    };
    const delegate: any = {
      findMany: async (args: any = {}) => {
        const rows = await query(args);
        if (args.include?.events)
          for (const row of rows)
            row.events = await adapter.workspaceEvent.findMany({
              where: { runId: row.id },
              orderBy: { createdAt: "asc" },
            });
        return rows;
      },
      findFirst: async (args: any = {}) => {
        const row = (await query(args))[0] ?? null;
        if (row && args.include?.events)
          row.events = await adapter.workspaceEvent.findMany({
            where: { runId: row.id },
            orderBy: { createdAt: "asc" },
          });
        return row;
      },
      create: async ({ data }: any) => {
        const row = { ...data };
        if (table !== "WorkspaceHead" && !row.id) row.id = randomUUID();
        const fields = Object.keys(row).filter((k) => row[k] !== undefined);
        const result = await db.query(
          "INSERT INTO " +
            quote(table) +
            " (" +
            fields.map(quote).join(",") +
            ") VALUES (" +
            fields.map((_, i) => "$" + (i + 1)).join(",") +
            ") RETURNING *",
          fields.map((k) =>
            jsonFields.has(k) ? JSON.stringify(row[k]) : row[k],
          ),
        );
        return result.rows[0];
      },
      updateMany: async ({ where, data }: any) => {
        const values: any[] = [];
        const sets = Object.entries(data).map(([k, v]: any) => {
          values.push(v?.increment ?? v);
          return (
            quote(k) +
            " = " +
            (v?.increment ? quote(k) + " + " : "") +
            "$" +
            values.length
          );
        });
        const conditions = Object.entries(where).map(([k, v]) => {
          values.push(v);
          return quote(k) + " = $" + values.length;
        });
        const result = await db.query(
          "UPDATE " +
            quote(table) +
            " SET " +
            sets.join(",") +
            " WHERE " +
            conditions.join(" AND ") +
            " RETURNING *",
          values,
        );
        return { count: result.rows.length };
      },
    };
    delegate.update = async ({ where, data }: any) => {
      const result = await delegate.updateMany({ where, data });
      if (result.count !== 1) throw new Error("Missing fixture update");
      return delegate.findFirst({ where });
    };
    delegate.findUnique = delegate.findFirst;
    delegate.upsert = async (args: any) =>
      (await delegate.findFirst({ where: args.where })) ??
      (await delegate.create({ data: args.create }));
    adapter[key] = delegate;
  }
  adapter.$transaction = (work: any) =>
    db.transaction((tx: any) => work(postgresAdapter(tx)));
  adapter.$queryRaw = (parts: TemplateStringsArray, ...values: any[]) =>
    db.query(
      parts.reduce((sql, part, i) => sql + (i ? "$" + i : "") + part, ""),
      values,
    );
  return adapter;
}
