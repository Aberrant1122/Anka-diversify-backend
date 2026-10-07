import { Request, Response } from "express";
import { ProjectController } from "../project-controller";
jest.mock("../../services/project-service", () => {
  const createFile = jest.fn();
  const deleteFile = jest.fn();
  return {
    ProjectService: jest.fn().mockImplementation(() => ({ createFile, deleteFile })),
    mockCreateFile: createFile,
    mockDeleteFile: deleteFile,
  };
});
const mockCreateFile = (require("../../services/project-service") as { mockCreateFile: jest.Mock }).mockCreateFile;
const mockDeleteFile = (require("../../services/project-service") as { mockDeleteFile: jest.Mock }).mockDeleteFile;
jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client");
  const findFirst = jest.fn();
  return { ...actual, PrismaClient: jest.fn().mockImplementation(() => ({ projectFile: { findFirst } })),
    mockFindFirst: findFirst };
});
const mockFindFirst = (require("@prisma/client") as { mockFindFirst: jest.Mock }).mockFindFirst;
jest.mock("../../services/upload.service", () => {
  const generateDownloadUrl = jest.fn();
  const deleteFromS3 = jest.fn();
  return { generatePresignedUrl: jest.fn(), generateDownloadUrl, deleteFromS3, detectType: jest.fn(),
    mockGenerateDownloadUrl: generateDownloadUrl, mockDeleteFromS3: deleteFromS3 };
});
const mockGenerateDownloadUrl = (require("../../services/upload.service") as { mockGenerateDownloadUrl: jest.Mock }).mockGenerateDownloadUrl;
const mockDeleteFromS3 = (require("../../services/upload.service") as { mockDeleteFromS3: jest.Mock }).mockDeleteFromS3;

const keyA = "projects/project-a/123e4567-e89b-42d3-a456-426614174000.pdf";
const keyB = "projects/project-b/123e4567-e89b-42d3-a456-426614174000.pdf";
const url = (key: string) =>
  `https://${process.env.AWS_S3_BUCKET || "anka-os-documents"}.s3.${process.env.AWS_REGION || "ap-south-1"}.amazonaws.com/${key}`;

describe("upload confirmation binds key and URL to route project", () => {
  const controller = new ProjectController();
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateFile.mockResolvedValue({ id: "file-a", projectId: "project-a" });
    mockDeleteFile.mockResolvedValue(undefined);
    mockGenerateDownloadUrl.mockResolvedValue("signed-url");
  });

  async function confirm(s3Key: unknown, fileUrl: unknown) {
    const req = { params: { id: "project-a" }, user: { userId: "both-projects-user" },
      body: { name: "document.pdf", s3Key, url: fileUrl } } as unknown as Request;
    const response = { statusCode: 200, body: undefined as unknown };
    const res = {
      status(code: number) { response.statusCode = code; return this; },
      json(body: unknown) { response.body = body; return this; },
    } as unknown as Response;
    await controller.confirmUpload(req, res);
    return response;
  }

  test("valid Project A key and matching URL creates the Project A file", async () => {
    expect((await confirm(keyA, url(keyA))).statusCode).toBe(201);
    expect(mockCreateFile).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-a", s3Key: keyA }));
  });

  test.each([
    [keyB, url(keyB)],
    [keyA, url(keyB)],
    ["projects/project-a/not-a-generated-key.pdf", url("projects/project-a/not-a-generated-key.pdf")],
  ])("cross-project or malformed key cannot create a file", async (key, fileUrl) => {
    expect((await confirm(key, fileUrl)).statusCode).toBe(404);
    expect(mockCreateFile).not.toHaveBeenCalled();
  });

  test("foreign file cannot be signed or deleted through Project A", async () => {
    mockFindFirst.mockResolvedValue(null);
    const req = { params: { id: "project-a", fileId: "file-b" }, user: { userId: "both-projects-user" } } as unknown as Request;
    const response = { statusCode: 200 };
    const res = {
      status(code: number) { response.statusCode = code; return this; },
      json(_body: unknown) { return this; },
    } as unknown as Response;
    await controller.getFileDownloadUrl(req, res);
    expect(response.statusCode).toBe(404);
    expect(mockFindFirst).toHaveBeenCalledWith({ where: { id: "file-b", projectId: "project-a" } });
    expect(mockGenerateDownloadUrl).not.toHaveBeenCalled();

    await controller.deleteFile(req, res);
    expect(response.statusCode).toBe(404);
    expect(mockDeleteFile).toHaveBeenCalledWith("project-a", "file-b");
    expect(mockDeleteFromS3).not.toHaveBeenCalled();
  });

  test("stored foreign key is never signed", async () => {
    mockFindFirst.mockResolvedValue({ id: "file-a", projectId: "project-a", s3Key: keyB });
    const req = { params: { id: "project-a", fileId: "file-a" } } as unknown as Request;
    const response = { statusCode: 200 };
    const res = {
      status(code: number) { response.statusCode = code; return this; },
      json(_body: unknown) { return this; },
    } as unknown as Response;
    await controller.getFileDownloadUrl(req, res);
    expect(response.statusCode).toBe(404);
    expect(mockGenerateDownloadUrl).not.toHaveBeenCalled();
  });
});
