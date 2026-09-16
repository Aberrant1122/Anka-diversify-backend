const mockFindUniqueUser = jest.fn();
const mockFindFirstProject = jest.fn();

jest.mock("../database", () => ({
  prisma: {
    user: { findUnique: mockFindUniqueUser },
    project: { findFirst: mockFindFirstProject },
  },
}));

import { ProjectSidebarService } from "../project-sidebar.service";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("project sidebar authorization", () => {
  test("scopes regular users to projects they own or belong to", async () => {
    mockFindUniqueUser.mockResolvedValue({ role: "member" });
    mockFindFirstProject.mockResolvedValue(null);

    await expect(ProjectSidebarService.getAccessibleProject("project-b", "user-a")).resolves.toBeNull();
    expect(mockFindFirstProject).toHaveBeenCalledWith({
      where: {
        id: "project-b",
        OR: [{ userId: "user-a" }, { members: { some: { userId: "user-a" } } }],
      },
      select: { id: true, githubUrl: true, githubToken: true },
    });
  });

  test("retains system-admin project access", async () => {
    mockFindUniqueUser.mockResolvedValue({ role: "admin" });
    mockFindFirstProject.mockResolvedValue({ id: "project-b", githubUrl: null, githubToken: null });

    await expect(ProjectSidebarService.getAccessibleProject("project-b", "admin-a")).resolves.toMatchObject({ id: "project-b" });
    expect(mockFindFirstProject).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "project-b" } }));
  });
});
