// One-off, idempotent backfill: mirrors each Project's legacy githubUrl/githubToken/localPath
// into a primary ProjectRepository row (Anka OS v2.0 spec §11 migration). Safe to re-run —
// skips any project that already has an isPrimary repository.
import { PrismaClient } from "@prisma/client";
import { ProjectRepositoryService } from "../src/services/project-repository-service";

const prisma = new PrismaClient();
const repoService = new ProjectRepositoryService();

async function main() {
  const projects = await prisma.project.findMany({
    where: { githubUrl: { not: null } },
    select: { id: true, name: true, githubUrl: true },
  });

  let created = 0;
  let skipped = 0;

  for (const project of projects) {
    const existing = await prisma.projectRepository.findFirst({
      where: { projectId: project.id, isPrimary: true },
    });
    if (existing) {
      skipped++;
      continue;
    }

    const primary = await repoService.ensurePrimaryRepository(project.id);
    if (primary) {
      created++;
      console.log(`Backfilled ProjectRepository for "${project.name}" (${project.id}) -> ${primary.name} (${primary.id})`);
    } else {
      skipped++;
    }
  }

  console.log(`\nDone. Created: ${created}, already had a primary repo: ${skipped}, total projects with a repo: ${projects.length}`);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
