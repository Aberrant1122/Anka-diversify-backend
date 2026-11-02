import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { ownerBootstrap } from "../src/config/owner-bootstrap";

const prisma = new PrismaClient();

const CANONICAL_ROLES: Array<{ name: string; description: string }> = [
  { name: "admin", description: "Full access, including org settings, rules, and user management" },
  { name: "manager", description: "Manages projects and team assignments" },
  { name: "developer", description: "Builds and ships product work" },
  { name: "designer", description: "Owns design and content deliverables" },
  { name: "tester", description: "Owns QA and validation" },
];

async function seedRoles() {
  for (const role of CANONICAL_ROLES) {
    await prisma.role.upsert({
      where: { name: role.name },
      create: role,
      update: { description: role.description },
    });
  }
  console.log(`Seeded ${CANONICAL_ROLES.length} roles`);
}

async function main() {
  const { email, password, name } = ownerBootstrap();
  await seedRoles();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Admin user already exists: ${email}`);
    return;
  }

  const hashed = await bcrypt.hash(password, 12);
  await prisma.user.create({
    data: { name, email, password: hashed, role: "admin" },
  });

  console.log(`Admin user created: ${email}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
