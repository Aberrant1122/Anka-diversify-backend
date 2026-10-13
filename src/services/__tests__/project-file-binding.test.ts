import { ProjectService } from "../project-service";

jest.mock("../planning-authorization.service", () => {
  const assertCanEdit = jest.fn();
  return {
    PlanningAuthorizationService: jest.fn().mockImplementation(() => ({ assertCanEdit })),
    mockAssertCanEdit: assertCanEdit,
  };
});
const { mockAssertCanEdit } = require("../planning-authorization.service") as {
  mockAssertCanEdit: jest.Mock;
};

jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client");
  const findFirst = jest.fn();
  const deleteMany = jest.fn();
  return { ...actual, PrismaClient: jest.fn().mockImplementation(() => ({ projectFile: { findFirst, deleteMany } })),
    mockFindFirst: findFirst, mockDeleteMany: deleteMany };
});
const { mockFindFirst, mockDeleteMany } = require("@prisma/client") as {
  mockFindFirst: jest.Mock; mockDeleteMany: jest.Mock;
};

describe("ProjectService file deletion route-project binding", () => {
  const service = new ProjectService();
  const keyA = "projects/project-a/123e4567-e89b-42d3-a456-426614174000.pdf";
  const keyB = "projects/project-b/123e4567-e89b-42d3-a456-426614174000.pdf";
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertCanEdit.mockResolvedValue({ id: "project-a" });
    mockFindFirst.mockImplementation(async ({ where }: { where: { id: string; projectId: string } }) =>
      where.id === "file-b" && where.projectId === "project-b"
        ? { id: "file-b", projectId: "project-b", s3Key: keyB }
        : where.id === "file-a" && where.projectId === "project-a"
          ? { id: "file-a", projectId: "project-a", s3Key: keyA }
          : where.id === "file-bad" && where.projectId === "project-a"
            ? { id: "file-bad", projectId: "project-a", s3Key: keyB }
          : null);
    mockDeleteMany.mockResolvedValue({ count: 1 });
  });

  test("same-project file may be deleted using a project-qualified mutation", async () => {
    await expect(service.deleteFile("project-a", "file-a", "owner-a")).resolves.toBe(keyA);
    expect(mockAssertCanEdit).toHaveBeenCalledWith("project-a", "owner-a");
    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { id: "file-a", projectId: "project-a" } });
  });

  test("cross-project and missing files have the same result with no mutation", async () => {
    await expect(service.deleteFile("project-a", "file-b", "owner-a")).resolves.toBeUndefined();
    await expect(service.deleteFile("project-a", "missing", "owner-a")).resolves.toBeUndefined();
    await expect(service.deleteFile("project-a", "file-bad", "owner-a")).resolves.toBeUndefined();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });
});
