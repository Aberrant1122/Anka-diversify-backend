import { assertOwner, ProjectActor } from "../security/project-access";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function mapTask(t: any) {
  return {
    id: t.id,
    title: t.title,
    description: t.description || null,
    status: t.status,
    priority: t.priority,
    phase: t.phase,
    dueDate: t.dueDate || null,
  };
}

export class SprintService {
  async getSprints(projectId: string, actorId: string) {
    await assertOwner(prisma, projectId, actorId);
    const sprints = await prisma.sprint.findMany({
      where: { projectId },
      include: {
        tasks: {
          include: { task: true },
        },
      },
      orderBy: { startDate: "desc" },
    });

    return sprints.map((s) => ({
      id: s.id,
      name: s.name,
      goal: s.goal,
      projectId: s.projectId,
      startDate: s.startDate,
      endDate: s.endDate,
      status: s.status,
      velocity: s.velocity,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      tasks: s.tasks.map((st) => mapTask(st.task)),
    }));
  }

  async createSprint(
    projectId: string,
    data: {
      name: string;
      goal?: string;
      startDate: string;
      endDate: string;
      status?: string;
      velocity?: number;
    },
    actorId: string,
  ) {
    await assertOwner(prisma, projectId, actorId);
    const sprint = await prisma.sprint.create({
      data: {
        projectId,
        name: data.name,
        goal: data.goal,
        startDate: new Date(data.startDate),
        endDate: new Date(data.endDate),
        status: data.status || "planning",
        velocity: data.velocity || 0,
      },
      include: {
        tasks: {
          include: { task: true },
        },
      },
    });

    return {
      id: sprint.id,
      name: sprint.name,
      goal: sprint.goal,
      projectId: sprint.projectId,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
      status: sprint.status,
      velocity: sprint.velocity,
      createdAt: sprint.createdAt,
      updatedAt: sprint.updatedAt,
      tasks: sprint.tasks.map((st) => mapTask(st.task)),
    };
  }

  async updateSprint(
    sprintId: string,
    data: Partial<{
      name: string;
      goal: string;
      startDate: string;
      endDate: string;
      status: string;
      velocity: number;
    }>,
    actor: ProjectActor,
  ) {
    await assertOwner(prisma, actor.projectId, actor.userId);
    const sprint = await prisma.sprint.update({
      where: { id: sprintId, projectId: actor.projectId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.goal !== undefined && { goal: data.goal }),
        ...(data.startDate !== undefined && {
          startDate: new Date(data.startDate),
        }),
        ...(data.endDate !== undefined && { endDate: new Date(data.endDate) }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.velocity !== undefined && { velocity: data.velocity }),
      },
      include: {
        tasks: {
          include: { task: true },
        },
      },
    });

    return {
      id: sprint.id,
      name: sprint.name,
      goal: sprint.goal,
      projectId: sprint.projectId,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
      status: sprint.status,
      velocity: sprint.velocity,
      createdAt: sprint.createdAt,
      updatedAt: sprint.updatedAt,
      tasks: sprint.tasks.map((st) => mapTask(st.task)),
    };
  }

  async deleteSprint(sprintId: string, actor: ProjectActor) {
    await assertOwner(prisma, actor.projectId, actor.userId);
    await prisma.sprint.delete({
      where: { id: sprintId, projectId: actor.projectId },
    });
  }

  async addTaskToSprint(sprintId: string, taskId: string, actor: ProjectActor) {
    await assertOwner(prisma, actor.projectId, actor.userId);
    if (
      !(await prisma.sprint.findFirst({
        where: { id: sprintId, projectId: actor.projectId },
        select: { id: true },
      })) ||
      !(await prisma.projectTask.findFirst({
        where: { id: taskId, projectId: actor.projectId },
        select: { id: true },
      }))
    )
      throw new Error("Sprint task outside project");
    try {
      await prisma.sprintTask.create({ data: { sprintId, taskId } });
    } catch (err: any) {
      // P2002 = unique constraint — already exists, ignore
      if (err?.code !== "P2002") throw err;
    }
  }

  async removeTaskFromSprint(
    sprintId: string,
    taskId: string,
    actor: ProjectActor,
  ) {
    await assertOwner(prisma, actor.projectId, actor.userId);
    if (
      !(await prisma.sprint.findFirst({
        where: { id: sprintId, projectId: actor.projectId },
        select: { id: true },
      })) ||
      !(await prisma.projectTask.findFirst({
        where: { id: taskId, projectId: actor.projectId },
        select: { id: true },
      }))
    )
      throw new Error("Sprint task outside project");
    await prisma.sprintTask.deleteMany({ where: { sprintId, taskId } });
  }
}
