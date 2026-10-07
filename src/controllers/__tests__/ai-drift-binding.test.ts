import { Request, Response } from "express";
import { AiController } from "../ai-controller";

jest.mock("../../ai/application/AiService", () => ({ AiService: { getInstance: () => ({}) } }));
jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client");
  const findFirst = jest.fn();
  const update = jest.fn();
  return { ...actual, PrismaClient: jest.fn().mockImplementation(() => ({
    architectureDriftRecord: { findFirst, update },
  })), mockFindFirst: findFirst, mockUpdate: update };
});
const { mockFindFirst, mockUpdate } = require("@prisma/client") as {
  mockFindFirst: jest.Mock; mockUpdate: jest.Mock;
};

describe("AI drift record project binding", () => {
  const controller = new AiController();
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindFirst.mockImplementation(async ({ where }: { where: { id: string; projectId: string } }) =>
      where.id === `${where.projectId}-record` ? { id: where.id, projectId: where.projectId } : null);
    mockUpdate.mockResolvedValue({ id: "project-a-record", projectId: "project-a", status: "dismissed" });
  });

  async function resolve(recordId: string) {
    const req = { params: { projectId: "project-a", recordId }, body: { status: "dismissed" } } as unknown as Request;
    const response = { statusCode: 200, body: undefined as unknown };
    const res = {
      status(code: number) { response.statusCode = code; return this; },
      json(body: unknown) { response.body = body; return this; },
    } as unknown as Response;
    await controller.resolveDriftRecord(req, res);
    return response;
  }

  test("same-project record may be resolved", async () => {
    expect((await resolve("project-a-record")).statusCode).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  test("cross-project and missing records are identical and cause no mutation", async () => {
    const cross = await resolve("project-b-record");
    const missing = await resolve("missing-record");
    expect(cross).toEqual(missing);
    expect(cross.statusCode).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
