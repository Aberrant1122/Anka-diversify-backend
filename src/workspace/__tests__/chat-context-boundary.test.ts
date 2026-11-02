import { PrismaClient } from "@prisma/client";
import { MemoryPersistence } from "../../ai/memory/MemoryPersistence";
jest.mock("@prisma/client", () => {
  const database = { aiChatSession: { findFirst: jest.fn() } };
  return {
    ...jest.requireActual("@prisma/client"),
    PrismaClient: jest.fn(() => database),
  };
});
const database = new PrismaClient();
describe("chat session context boundary", () => {
  beforeEach(() => jest.clearAllMocks());
  it("requires the exact project and its current owner when reading a session", async () => {
    (database.aiChatSession.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(
      MemoryPersistence.getSessionMessages("foreign-session", "owner", {
        type: "project",
        projectId: "p",
      }),
    ).rejects.toThrow("Session not found");
    expect(database.aiChatSession.findFirst).toHaveBeenCalledWith({
      where: {
        id: "foreign-session",
        userId: "owner",
        type: "project",
        projectId: "p",
        project: { userId: "owner" },
      },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
  });
  it("does not expose a project session through the general chat endpoint", async () => {
    (database.aiChatSession.findFirst as jest.Mock).mockResolvedValue({
      id: "general",
      messages: [],
    });
    expect(
      await MemoryPersistence.getSessionMessages("general", "owner", {
        type: "general",
      }),
    ).toMatchObject({ id: "general" });
    expect(database.aiChatSession.findFirst).toHaveBeenCalledWith({
      where: {
        id: "general",
        userId: "owner",
        type: "general",
        projectId: null,
      },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
  });
});
