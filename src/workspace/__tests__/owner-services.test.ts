import { PrismaClient } from "@prisma/client";
import { AiService } from "../../ai/application/AiService";
import { ProjectChatService } from "../../ai/application/ProjectChatService";
import { ProjectService } from "../../services/project-service";
import { ProjectRepositoryService } from "../../services/project-repository-service";
import { SprintService } from "../../services/sprint-service";
import { KanbanService } from "../../services/kanban-service";
import { ClarificationHandlerService } from "../../services/clarification-handler.service";
jest.mock("@prisma/client", () => {
  const database = new Proxy(
    {},
    {
      get(target: Record<string, unknown>, name: string) {
        return (target[name] ||= {
          findFirst: jest.fn(),
          findUnique: jest.fn(),
          findMany: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
          delete: jest.fn(),
          upsert: jest.fn(),
          deleteMany: jest.fn(),
        });
      },
    },
  );
  return {
    ...jest.requireActual("@prisma/client"),
    PrismaClient: jest.fn(() => database),
  };
});
const db = new PrismaClient(),
  project = new ProjectService(),
  repos = new ProjectRepositoryService(),
  sprint = new SprintService(),
  kanban = new KanbanService(),
  clarification = new ClarificationHandlerService();
const actor = { projectId: "p", userId: "owner" };
const ai = AiService.getInstance();
const cases: [string, () => Promise<unknown>][] = [
  [
    "AI direct sprint suggestions",
    () =>
      new ProjectChatService().suggestSprintTasks("p", "sprint", 10, "owner"),
  ],
  [
    "AI direct sprint generation",
    () => new ProjectChatService().generateSprint("p", "note", "owner"),
  ],
  [
    "AI direct task order",
    () => new ProjectChatService().suggestTaskOrder("p", "owner", []),
  ],
  [
    "AI direct phase proposal",
    () =>
      new ProjectChatService().generatePhaseProposal("p", "marketing", "owner"),
  ],
  ["AI project context", () => ai.getProjectContext("p", "owner")],
  ["AI project health", () => ai.getProjectHealth("p", "owner")],
  [
    "AI sprint suggestions",
    () => ai.suggestSprintTasks("p", "sprint", 10, "owner"),
  ],
  ["AI sprint generation", () => ai.generateSprint("p", "note", "owner")],
  ["AI task order", () => ai.suggestTaskOrder("p", "owner", [])],
  ["AI PR review", () => ai.reviewPullRequest("p", 1, "owner")],
  ["AI PR description", () => ai.generatePRDescription("p", 1, "owner")],
  [
    "AI phase proposal",
    () => ai.generatePhaseProposal("p", "marketing", "owner"),
  ],
  ["AI project sessions", () => ai.getSessions("owner", "project", "p")],
  [
    "AI chat facade",
    () => ai.processProjectChat("owner", "p", { message: "note" }),
  ],
  [
    "AI direct project chat",
    () =>
      new ProjectChatService().processProjectChat("owner", "p", {
        message: "note",
      }),
  ],
  ["project chat read", () => project.getChatMessages("p", "owner")],
  [
    "project chat write",
    () =>
      project.sendChatMessage({
        projectId: "p",
        userId: "owner",
        userName: "Owner",
        content: "note",
      }),
  ],
  [
    "activity write",
    () =>
      project.logActivity({
        projectId: "p",
        userId: "owner",
        userName: "Owner",
        action: "note",
        entityType: "task",
      }),
  ],
  ["activity read", () => project.getActivities("p", "owner")],
  ["comments read", () => project.getComments("task", actor)],
  [
    "comments create",
    () =>
      project.createComment({
        projectId: "p",
        userId: "owner",
        userName: "Owner",
        taskId: "task",
        content: "note",
      }),
  ],
  [
    "comments delete",
    () => project.deleteComment("comment", { ...actor, taskId: "task" }),
  ],
  ["files read", () => project.getProjectFiles("p", "owner")],
  [
    "files create",
    () => project.createFile({ projectId: "p", name: "note" }, "owner"),
  ],
  ["files delete", () => project.deleteFile("file", actor)],
  [
    "rules create",
    () =>
      project.createProjectRule(
        { projectId: "p", title: "Rule", description: "Bounded" },
        "owner",
      ),
  ],
  [
    "rules update",
    () => project.updateProjectRule("rule", { title: "Changed" }, actor),
  ],
  ["rules delete", () => project.deleteProjectRule("rule", actor)],
  [
    "decisions create",
    () =>
      project.createProjectDecision(
        { projectId: "p", title: "Decision", description: "Bounded" },
        "owner",
      ),
  ],
  [
    "decisions update",
    () =>
      project.updateProjectDecision("decision", { title: "Changed" }, actor),
  ],
  ["decisions delete", () => project.deleteProjectDecision("decision", actor)],
  [
    "memory write",
    () => project.saveMemorySummary("p", "Subordinate context", "owner"),
  ],
  ["task statistics", () => project.getTaskStats("p", "owner")],
  ["repository ensure", () => repos.ensurePrimaryRepository("p", "owner")],
  ["repository list", () => repos.list("p", "owner")],
  [
    "repository create",
    () =>
      repos.create(
        "p",
        {
          name: "Repo",
          role: "backend",
          githubUrl: "https://github.com/example/repo",
        },
        "owner",
      ),
  ],
  [
    "repository update",
    () => repos.update("p", "repo", { name: "Changed" }, "owner"),
  ],
  ["repository delete", () => repos.remove("p", "repo", "owner")],
  ["repository token", () => repos.getDecryptedToken("repo", actor)],
  ["repository sync", () => repos.sync("p", "repo", "owner")],
  [
    "repository resolution",
    () => repos.resolveRepositoryForAgent("p", "repo", "owner"),
  ],
  ["sprint read", () => sprint.getSprints("p", "owner")],
  [
    "sprint create",
    () =>
      sprint.createSprint(
        "p",
        { name: "Sprint", startDate: "2026-01-01", endDate: "2026-01-02" },
        "owner",
      ),
  ],
  [
    "sprint update",
    () => sprint.updateSprint("sprint", { name: "Changed" }, actor),
  ],
  ["sprint delete", () => sprint.deleteSprint("sprint", actor)],
  ["sprint add task", () => sprint.addTaskToSprint("sprint", "task", actor)],
  [
    "sprint remove task",
    () => sprint.removeTaskFromSprint("sprint", "task", actor),
  ],
  ["kanban read", () => kanban.getBoard("p", "owner")],
  ["kanban generate", () => kanban.generateBoardFromWorkflow("p", "owner")],
  ["kanban status", () => kanban.updateTaskStatus("task", "done", actor)],
  [
    "kanban clarification",
    () => kanban.resolveClarification("qa", "choice", actor),
  ],
  [
    "clarification create",
    () =>
      clarification.requestClarification(
        { taskId: "task", question: "Scope?", options: [] },
        actor,
      ),
  ],
  [
    "clarification resolve",
    () => clarification.resolveClarification("qa", "choice", actor),
  ],
  [
    "clarification context",
    () => clarification.getResolvedClarificationContext("task", actor),
  ],
];
describe("service-level owner boundary", () => {
  it("never drops the owner filter for a missing identity", async () => {
    await expect(project.getAllProjects(undefined as never)).rejects.toThrow(
      "Authenticated",
    );
    await expect(
      project.getProjectById("p", undefined as never),
    ).rejects.toThrow("Authenticated");
  });
  beforeEach(() => {
    jest.clearAllMocks();
    (db.project.findFirst as jest.Mock).mockResolvedValue(null);
  });
  it.each(cases)(
    "denies %s before touching children or providers",
    async (_name, call) => {
      await expect(call()).rejects.toThrow("Project not found or inaccessible");
    },
  );
  it("binds comment reads to the project as well as task", async () => {
    (db.project.findFirst as jest.Mock).mockResolvedValue({ id: "p" });
    await project.getComments("foreign-task", actor);
    expect(db.taskComment.findMany).toHaveBeenCalledWith({
      where: { taskId: "foreign-task", projectId: "p" },
      orderBy: { createdAt: "asc" },
    });
  });
  it("rejects a foreign task before creating a comment", async () => {
    (db.project.findFirst as jest.Mock).mockResolvedValue({ id: "p" });
    (db.projectTask.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(
      project.createComment({
        projectId: "p",
        taskId: "foreign",
        userId: "owner",
        userName: "Owner",
        content: "note",
      }),
    ).rejects.toThrow("Task not found");
    expect(db.taskComment.create).not.toHaveBeenCalled();
  });
  it("cannot attach a foreign task to an owned sprint", async () => {
    (db.project.findFirst as jest.Mock).mockResolvedValue({ id: "p" });
    (db.sprint.findFirst as jest.Mock).mockResolvedValue({ id: "sprint" });
    (db.projectTask.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(
      sprint.addTaskToSprint("sprint", "foreign", actor),
    ).rejects.toThrow("outside project");
    expect(db.sprintTask.create).not.toHaveBeenCalled();
  });
  it("does not return a repository token from another project", async () => {
    (db.project.findFirst as jest.Mock).mockResolvedValue({ id: "p" });
    (db.projectRepository.findFirst as jest.Mock).mockResolvedValue(null);
    expect(await repos.getDecryptedToken("foreign", actor)).toBeUndefined();
    expect(db.projectRepository.findFirst).toHaveBeenCalledWith({
      where: { id: "foreign", projectId: "p" },
    });
  });
});
