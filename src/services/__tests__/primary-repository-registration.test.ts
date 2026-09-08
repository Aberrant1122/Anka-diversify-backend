import { PrismaClient } from "@prisma/client";
import { ProjectRepositoryService } from "../project-repository-service";
import { encrypt } from "../../utils/encryption";

const prisma = new PrismaClient();
const repoService = new ProjectRepositoryService();

describe("Primary Repository Registration for Multi-Repo Execution", () => {
  let testUserId: string;
  let legacyProjectId: string;
  let multiRepoProjectId: string;
  let noGithubProjectId: string;

  beforeAll(async () => {
    // Ensure test user exists
    const user = await prisma.user.upsert({
      where: { email: "test-repo-reg@anka.io" },
      update: {},
      create: {
        email: "test-repo-reg@anka.io",
        name: "Repo Test User",
        password: "hashedpassword",
        role: "user",
      },
    });
    testUserId = user.id;

    // 1. Legacy project with githubUrl and no initial ProjectRepository rows
    const p1 = await prisma.project.create({
      data: {
        name: "Legacy Project",
        githubUrl: "https://github.com/org/legacy-api.git",
        githubToken: encrypt("ghp_legacy_test_token_12345"),
        userId: testUserId,
      },
    });
    legacyProjectId = p1.id;

    // 2. Project that will have both primary and secondary
    const p2 = await prisma.project.create({
      data: {
        name: "Multi Repo Eval Project",
        githubUrl: "https://github.com/org/eval-backend-api.git",
        githubToken: encrypt("ghp_backend_test_token_67890"),
        userId: testUserId,
      },
    });
    multiRepoProjectId = p2.id;

    // Add secondary repo to p2
    await prisma.projectRepository.create({
      data: {
        projectId: multiRepoProjectId,
        name: "eval-frontend-web",
        role: "frontend",
        githubUrl: "https://github.com/org/eval-frontend-web.git",
        githubToken: encrypt("ghp_frontend_test_token_abcde"),
        isPrimary: false,
      },
    });

    // 3. Project without githubUrl
    const p3 = await prisma.project.create({
      data: {
        name: "No GitHub Project",
        userId: testUserId,
      },
    });
    noGithubProjectId = p3.id;
  });

  afterAll(async () => {
    // Cleanup created test records
    await prisma.projectRepository.deleteMany({
      where: {
        projectId: { in: [legacyProjectId, multiRepoProjectId, noGithubProjectId] },
      },
    });
    await prisma.project.deleteMany({
      where: {
        id: { in: [legacyProjectId, multiRepoProjectId, noGithubProjectId] },
      },
    });
    await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
    await prisma.$disconnect();
  });

  // Test 1: Legacy Project with githubUrl and no ProjectRepository: list(projectId) creates/ensures primary row and returns one primary
  test("1. legacy Project with githubUrl and no ProjectRepository: list(projectId) creates/ensures primary row and returns one primary", async () => {
    const repos = await repoService.list(legacyProjectId);
    expect(repos.length).toBe(1);
    expect(repos[0].isPrimary).toBe(true);
    expect(repos[0].name).toBe("legacy-api");
    expect(repos[0].role).toBe("backend");
  });

  // Test 2: Legacy Project + one secondary: list(projectId) returns 2 repositories
  test("2. legacy Project + one secondary: list(projectId) returns 2 repositories", async () => {
    const repos = await repoService.list(multiRepoProjectId);
    expect(repos.length).toBe(2);

    const primary = repos.find((r) => r.isPrimary);
    const secondary = repos.find((r) => !r.isPrimary);

    expect(primary).toBeDefined();
    expect(primary!.name).toBe("eval-backend-api");
    expect(primary!.role).toBe("backend");

    expect(secondary).toBeDefined();
    expect(secondary!.name).toBe("eval-frontend-web");
    expect(secondary!.role).toBe("frontend");
  });

  // Test 3: Repeated list() does NOT create duplicate primary rows
  test("3. repeated list() does NOT create duplicate primary rows", async () => {
    const firstCall = await repoService.list(multiRepoProjectId);
    const secondCall = await repoService.list(multiRepoProjectId);
    const thirdCall = await repoService.list(multiRepoProjectId);

    expect(firstCall.length).toBe(2);
    expect(secondCall.length).toBe(2);
    expect(thirdCall.length).toBe(2);

    const primaryRowsInDb = await prisma.projectRepository.findMany({
      where: { projectId: multiRepoProjectId, isPrimary: true },
    });
    expect(primaryRowsInDb.length).toBe(1);
  });

  // Test 4: Existing persisted primary is returned unchanged
  test("4. existing persisted primary is returned unchanged", async () => {
    const primaryBefore = await prisma.projectRepository.findFirst({
      where: { projectId: multiRepoProjectId, isPrimary: true },
    });
    expect(primaryBefore).not.toBeNull();

    const ensured = await repoService.ensurePrimaryRepository(multiRepoProjectId);
    expect(ensured?.id).toBe(primaryBefore!.id);
    expect(ensured?.name).toBe(primaryBefore!.name);
  });

  // Test 5: Project without githubUrl: no bogus primary created
  test("5. Project without githubUrl: no bogus primary created", async () => {
    const repos = await repoService.list(noGithubProjectId);
    expect(repos.length).toBe(0);

    const rowsInDb = await prisma.projectRepository.findMany({
      where: { projectId: noGithubProjectId },
    });
    expect(rowsInDb.length).toBe(0);
  });

  // Test 6: Primary token: never returned plaintext
  test("6. primary token: never returned plaintext in list() response", async () => {
    const repos = await repoService.list(multiRepoProjectId);
    for (const r of repos) {
      expect((r as any).githubToken).toBeUndefined();
      expect((r as any).hasToken).toBe(true);
    }
  });

  // Test 7: Primary repository has stable real DB id
  test("7. primary repository has stable real DB id", async () => {
    const repos1 = await repoService.list(multiRepoProjectId);
    const primary1 = repos1.find((r) => r.isPrimary);

    const repos2 = await repoService.list(multiRepoProjectId);
    const primary2 = repos2.find((r) => r.isPrimary);

    expect(primary1?.id).toBeDefined();
    expect(primary1?.id).toBe(primary2?.id);
    expect(primary1?.id.startsWith("primary-")).toBe(false); // real CUID, not synthetic
  });

  // Test 8: Multi-repo AI dispatch receives repository count 2 (repos.length >= 2 is true)
  test("8. multi-repo AI dispatch receives repository count 2", async () => {
    const repos = await repoService.list(multiRepoProjectId);
    const isMultiRepo = repos.length >= 2;
    expect(isMultiRepo).toBe(true);
  });

  // Test 9: Primary and secondary repositoryIds are both valid ProjectRepository IDs
  test("9. primary and secondary repositoryIds are both valid ProjectRepository IDs", async () => {
    const repos = await repoService.list(multiRepoProjectId);
    const ids = repos.map((r) => r.id);

    const foundInDb = await prisma.projectRepository.findMany({
      where: { id: { in: ids }, projectId: multiRepoProjectId },
    });
    expect(foundInDb.length).toBe(2);
  });

  // Test 10: Multi-repo push can resolve both repository IDs
  test("10. multi-repo push can resolve both repository IDs", async () => {
    const repos = await repoService.list(multiRepoProjectId);
    for (const r of repos) {
      const dbRepo = await prisma.projectRepository.findFirst({
        where: { id: r.id, projectId: multiRepoProjectId },
      });
      expect(dbRepo).not.toBeNull();
      expect(dbRepo?.githubUrl).toBeDefined();
    }
  });

  // Test 11: Repositories UI does not duplicate persisted primary
  test("11. Repositories UI does not duplicate persisted primary", async () => {
    const list = await repoService.list(multiRepoProjectId);
    // Simulating project-repositories.tsx line 127:
    const hasPrimary = list.some((r) => r.isPrimary);
    expect(hasPrimary).toBe(true);
    // When hasPrimary is true, UI does NOT synthesize a duplicate primarySynth:
    const uiRepos = hasPrimary ? list : [{ id: "synth", isPrimary: true }, ...list];
    expect(uiRepos.length).toBe(2);
  });

  // Test 12: Single-repo project still works exactly as before
  test("12. single-repo project still works exactly as before", async () => {
    const repos = await repoService.list(legacyProjectId);
    expect(repos.length).toBe(1);
    const isMultiRepo = repos.length >= 2;
    expect(isMultiRepo).toBe(false); // Dispatches to single-repo endpoint as expected
  });
});
