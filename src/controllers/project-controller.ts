import fs from "fs";
import path from "path";
import { Request, Response } from "express";
import { ProjectService } from "../services/project-service";
import { ProjectGitHubService } from "../services/github.service";
import { generatePresignedUrl, generateDownloadUrl, deleteFromS3, detectType } from "../services/upload.service";
import { notificationService } from "../services/notification-service";
import { PrismaClient } from "@prisma/client";
import { encrypt, decrypt, validateGitHubToken as validateToken } from "../utils/encryption";
const prisma = new PrismaClient();

const projectService = new ProjectService();
function getUserId(req: Request): string {
  const userId = req.user?.userId as string | undefined;

  if (!userId) {
    throw new Error("Authenticated user ID missing");
  }

  return userId;
}

function getUserName(req: Request): string {
  return (req.user?.email as string | undefined) || "Authenticated User";
}

function param(req: Request, key: string): string {
  return req.params[key] as string;
}

export class ProjectController {
  async getProjects(req: Request, res: Response) {
    try {
      const projects = await projectService.getAllProjects(getUserId(req));
      res.json({ success: true, data: projects, count: projects.length });
    } catch (error) {
      console.error("Error fetching projects:", error);
      res.status(500).json({ success: false, error: "Failed to fetch projects" });
    }
  }

  async getProjectById(req: Request, res: Response) {
    try {
      const project = await projectService.getProjectById(param(req, "id"), getUserId(req));
      if (!project) {
        return res.status(404).json({ success: false, error: "Project not found" });
      }
      res.json({ success: true, data: project });
    } catch (error) {
      console.error("Error fetching project:", error);
      res.status(500).json({ success: false, error: "Failed to fetch project" });
    }
  }

  async createProject(req: Request, res: Response) {
    try {
      const userId = getUserId(req);
      const { name, description, phase, priority, githubUrl, githubToken, localPath, dueDate } = req.body;

      // Validate required fields
      if (!name) {
        return res.status(400).json({ success: false, error: "Project name is required" });
      }

      // If GitHub URL is provided, token is required
      if (githubUrl && !githubToken) {
        return res.status(400).json({ 
          success: false, 
          error: "GitHub token is required when providing a GitHub URL" 
        });
      }

      // Validate and encrypt GitHub token if provided
      let encryptedToken: string | undefined;
      if (githubToken) {
        // Validate token with GitHub API
        const validation = await validateToken(githubToken);
        if (!validation.valid) {
          return res.status(400).json({ 
            success: false, 
            error: validation.error || "Invalid GitHub token" 
          });
        }

        // Encrypt the token before storing
        encryptedToken = encrypt(githubToken);
      }

      const project = await projectService.createProject(
        {
          name,
          description,
          phase,
          priority,
          githubUrl,
          githubToken: encryptedToken,
          localPath,
          dueDate: dueDate || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
        },
        userId,
      );

      // Kick off GitHub context sync in background (don't block the response)
      if (githubUrl && githubToken) {
        ProjectGitHubService.buildProjectContext(project.id, githubUrl, githubToken).catch((err) =>
          console.error("GitHub sync failed for project", project.id, err),
        );
      }

      // Don't return the encrypted token in response
      const { githubToken: _, ...projectWithoutToken } = project;

      res.status(201).json({ 
        success: true, 
        data: projectWithoutToken, 
        message: "Project created successfully" 
      });
    } catch (error) {
      console.error("Error creating project:", error);
      res.status(500).json({ success: false, error: "Failed to create project" });
    }
  }

  async updateProject(req: Request, res: Response) {
    try {
      const userId = getUserId(req);
      const project = await projectService.updateProject(param(req, "id"), req.body, userId);

      if (!project) {
        return res.status(404).json({ success: false, error: "Project not found" });
      }

      if (req.body.githubUrl) {
        // Get the decrypted token for syncing
        const token = project.githubToken ? decrypt(project.githubToken) : undefined;
        
        ProjectGitHubService.buildProjectContext(project.id, req.body.githubUrl, token).catch((err) =>
          console.error("GitHub sync failed for project", project.id, err),
        );
      }

      // Don't return the encrypted token in response
      const { githubToken: _, ...projectWithoutToken } = project;

      res.json({ success: true, data: projectWithoutToken, message: "Project updated successfully" });
    } catch (error) {
      console.error("Error updating project:", error);
      res.status(500).json({ success: false, error: "Failed to update project" });
    }
  }

  async updateProjectGitHubToken(req: Request, res: Response) {
    try {
      const userId = getUserId(req);
      const { githubToken } = req.body;

      if (!githubToken) {
        return res.status(400).json({ success: false, error: "GitHub token is required" });
      }

      // Validate token with GitHub API
      const validation = await validateToken(githubToken);
      if (!validation.valid) {
        return res.status(400).json({ 
          success: false, 
          error: validation.error || "Invalid GitHub token" 
        });
      }

      // Encrypt and save
      const encryptedToken = encrypt(githubToken);
      await projectService.updateProjectGitHubToken(param(req, "id"), encryptedToken, userId);

      res.json({ 
        success: true, 
        message: "GitHub token updated successfully",
        data: { username: validation.username, scopes: validation.scopes }
      });
    } catch (error: any) {
      console.error("Error updating GitHub token:", error);
      res.status(error.message === 'Unauthorized to update this project' ? 403 : 500)
        .json({ success: false, error: error.message || "Failed to update GitHub token" });
    }
  }

  async validateGitHubToken(req: Request, res: Response) {
    try {
      const { githubToken } = req.body;

      if (!githubToken) {
        return res.status(400).json({ success: false, error: "GitHub token is required" });
      }

      const validation = await validateToken(githubToken);

      console.log('Token validation result:', { 
        valid: validation.valid, 
        username: validation.username,
        error: validation.error 
      });

      if (validation.valid) {
        res.json({ 
          success: true, 
          data: { 
            valid: true, 
            username: validation.username,
            scopes: validation.scopes 
          } 
        });
      } else {
        res.status(400).json({ 
          success: false, 
          error: validation.error || "Invalid GitHub token" 
        });
      }
    } catch (error: any) {
      console.error("Error validating GitHub token:", error);
      res.status(500).json({ 
        success: false, 
        error: error?.message || "Failed to validate GitHub token" 
      });
    }
  }

  async deleteProject(req: Request, res: Response) {
    try {
      const deleted = await projectService.deleteProject(param(req, "id"), getUserId(req));
      if (!deleted) {
        return res.status(404).json({ success: false, error: "Project not found" });
      }
      res.json({ success: true, message: "Project deleted successfully" });
    } catch (error) {
      console.error("Error deleting project:", error);
      res.status(500).json({ success: false, error: "Failed to delete project" });
    }
  }

  // ── IDE File Read/Write ───────────────────────────────────────────────────

  async getRepoFile(req: Request, res: Response) {
    try {
      const project = await projectService.getProjectById(param(req, "id"), getUserId(req));
      if (!project?.githubUrl) {
        return res.status(400).json({ success: false, error: "No GitHub repository connected" });
      }
      const filePath = req.query.path as string;
      if (!filePath) return res.status(400).json({ success: false, error: "path query param required" });

      // Decrypt the GitHub token
      const token = project.githubToken ? decrypt(project.githubToken) : undefined;

      const file = await ProjectGitHubService.getFileContent(project.githubUrl, filePath, token);
      if (!file) return res.status(404).json({ success: false, error: "File not found" });

      res.json({ success: true, data: { path: filePath, content: file.content, sha: file.sha } });
    } catch (error) {
      console.error("Error reading repo file:", error);
      res.status(500).json({ success: false, error: "Failed to read file" });
    }
  }

  async saveRepoFile(req: Request, res: Response) {
    try {
      const project = await projectService.getProjectById(param(req, "id"), getUserId(req));
      if (!project?.githubUrl) {
        return res.status(400).json({ success: false, error: "No GitHub repository connected" });
      }
      const { path: filePath, content, commitMessage } = req.body;
      if (!filePath || content === undefined) {
        return res.status(400).json({ success: false, error: "path and content required" });
      }

      // Decrypt the GitHub token
      const token = project.githubToken ? decrypt(project.githubToken) : undefined;

      const message = commitMessage || `edit: update ${filePath}`;
      const result = await ProjectGitHubService.pushChanges(project.githubUrl, [{ path: filePath, content }], message, token);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error("Error saving repo file:", error);
      res.status(500).json({ success: false, error: "Failed to save file" });
    }
  }

  async applyLocalChanges(req: Request, res: Response) {
    try {
      const project = await projectService.getProjectById(param(req, "id"), getUserId(req));
      if (!project?.localPath) {
        return res.status(400).json({ success: false, error: "No local path configured for this project" });
      }

      const { changes } = req.body as { changes: { path: string; content: string }[] };
      if (!changes?.length) {
        return res.status(400).json({ success: false, error: "No changes provided" });
      }

      const written: string[] = [];
      for (const change of changes) {
        const abs = path.join(project.localPath, change.path);
        // Prevent path traversal outside localPath
        if (!abs.startsWith(path.resolve(project.localPath))) {
          return res.status(400).json({ success: false, error: `Invalid path: ${change.path}` });
        }
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, change.content, "utf8");
        written.push(change.path);
      }

      res.json({ success: true, data: { written } });
    } catch (error) {
      console.error("Error applying local changes:", error);
      res.status(500).json({ success: false, error: "Failed to write local files" });
    }
  }

  async syncGithub(req: Request, res: Response) {
    try {
      const userId = getUserId(req);
      const project = await projectService.getProjectById(param(req, "id"), userId);

      if (!project) {
        return res.status(404).json({ success: false, error: "Project not found" });
      }

      const githubUrl = req.body.githubUrl || project.githubUrl;
      if (!githubUrl) {
        return res.status(400).json({ success: false, error: "No GitHub URL provided" });
      }

      // Decrypt the GitHub token
      const token = project.githubToken ? decrypt(project.githubToken) : undefined;

      await ProjectGitHubService.buildProjectContext(project.id, githubUrl, token);
      res.json({ success: true, message: "GitHub context synced successfully" });
    } catch (error) {
      console.error("Error syncing GitHub context:", error);
      res.status(500).json({ success: false, error: "Failed to sync GitHub context" });
    }
  }

  async getProjectTasks(req: Request, res: Response) {
    try {
      const tasks = await projectService.getProjectTasks(param(req, "id"), getUserId(req));
      res.json({ success: true, data: tasks, count: tasks.length });
    } catch (error) {
      console.error("Error fetching project tasks:", error);
      res.status(500).json({ success: false, error: "Failed to fetch project tasks" });
    }
  }

  async createTask(req: Request, res: Response) {
    try {
      const actor = { userId: getUserId(req), userName: getUserName(req) };
      const task = await projectService.createTask(
        {
          project_id: param(req, "id"),
          title: req.body.title,
          description: req.body.description,
          status: req.body.status,
          priority: req.body.priority,
          phase: req.body.phase,
          due_date: req.body.dueDate,
        },
        actor,
      );
      res.status(201).json({ success: true, data: task, message: "Task created successfully" });
    } catch (error) {
      console.error("Error creating task:", error);
      res.status(500).json({ success: false, error: "Failed to create task" });
    }
  }

  async updateTask(req: Request, res: Response) {
    try {
      const actor = { userId: getUserId(req), userName: getUserName(req), projectId: param(req, "id") };
      const task = await projectService.updateTask(param(req, "taskId"), req.body, actor);
      if (!task) {
        return res.status(404).json({ success: false, error: "Task not found" });
      }
      res.json({ success: true, data: task });
    } catch (error) {
      console.error("Error updating task:", error);
      res.status(500).json({ success: false, error: "Failed to update task" });
    }
  }

  async deleteTask(req: Request, res: Response) {
    try {
      const actor = { userId: getUserId(req), userName: getUserName(req), projectId: param(req, "id") };
      const deleted = await projectService.deleteTask(param(req, "taskId"), actor);
      if (!deleted) {
        return res.status(404).json({ success: false, error: "Task not found" });
      }
      res.json({ success: true, message: "Task deleted successfully" });
    } catch (error) {
      console.error("Error deleting task:", error);
      res.status(500).json({ success: false, error: "Failed to delete task" });
    }
  }

  async getProjectMembers(req: Request, res: Response) {
    try {
      const members = await projectService.getProjectMembers(param(req, "id"));
      res.json({ success: true, data: members });
    } catch (error) {
      console.error("Error fetching members:", error);
      res.status(500).json({ success: false, error: "Failed to fetch members" });
    }
  }

  async addProjectMember(req: Request, res: Response) {
    try {
      const { userId } = req.body;
      if (!userId) return res.status(400).json({ success: false, error: "userId required" });
      const member = await projectService.addProjectMember(param(req, "id"), userId);
      res.status(201).json({ success: true, data: member });
    } catch (error: any) {
      if (error?.code === "P2002") {
        return res.status(409).json({ success: false, error: "User is already a member" });
      }
      console.error("Error adding member:", error);
      res.status(500).json({ success: false, error: "Failed to add member" });
    }
  }

  async removeProjectMember(req: Request, res: Response) {
    try {
      const removed = await projectService.removeProjectMember(param(req, "id"), param(req, "userId"));
      if (!removed) return res.status(404).json({ success: false, error: "Member not found" });
      res.json({ success: true, message: "Member removed" });
    } catch (error) {
      console.error("Error removing member:", error);
      res.status(500).json({ success: false, error: "Failed to remove member" });
    }
  }

  async getChatMessages(req: Request, res: Response) {
    try {
      const messages = await projectService.getChatMessages(param(req, "id"));
      res.json({ success: true, data: messages });
    } catch (error) {
      console.error("Error fetching chat messages:", error);
      res.status(500).json({ success: false, error: "Failed to fetch messages" });
    }
  }

  async sendChatMessage(req: Request, res: Response) {
    try {
      const { content } = req.body;
      if (!content?.trim()) {
        return res.status(400).json({ success: false, error: "content is required" });
      }
      const message = await projectService.sendChatMessage({
        projectId: param(req, "id"),
        userId: getUserId(req),
        userName: getUserName(req),
        content: content.trim(),
      });
      res.status(201).json({ success: true, data: message });
    } catch (error) {
      console.error("Error sending chat message:", error);
      res.status(500).json({ success: false, error: "Failed to send message" });
    }
  }

  async getActivities(req: Request, res: Response) {
    try {
      const activities = await projectService.getActivities(param(req, "id"));
      res.json({ success: true, data: activities, count: activities.length });
    } catch (error) {
      console.error("Error fetching activities:", error);
      res.status(500).json({ success: false, error: "Failed to fetch activities" });
    }
  }

  async getComments(req: Request, res: Response) {
    try {
      const comments = await projectService.getComments(param(req, "taskId"));
      res.json({ success: true, data: comments, count: comments.length });
    } catch (error) {
      console.error("Error fetching comments:", error);
      res.status(500).json({ success: false, error: "Failed to fetch comments" });
    }
  }

  async createComment(req: Request, res: Response) {
    try {
      const { content } = req.body;
      if (!content?.trim()) {
        return res.status(400).json({ success: false, error: "content is required" });
      }
      const taskId = param(req, "taskId");
      const projectId = param(req, "id");
      const userId = getUserId(req);
      const userName = getUserName(req);
      const comment = await projectService.createComment({
        taskId,
        projectId,
        userId,
        userName,
        content: content.trim(),
      });

      // Fire-and-forget @mention notifications
      if (content.includes("@")) {
        Promise.all([
          prisma.projectTask.findUnique({ where: { id: taskId }, select: { title: true } }),
          prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }),
        ]).then(([task, project]) =>
          notificationService.handleMentions(content.trim(), userId, userName, {
            taskTitle: task?.title || "a task",
            projectName: project?.name || "a project",
            taskId,
            projectId,
          })
        ).catch(() => {});
      }

      res.status(201).json({ success: true, data: comment });
    } catch (error) {
      console.error("Error creating comment:", error);
      res.status(500).json({ success: false, error: "Failed to create comment" });
    }
  }

  async deleteComment(req: Request, res: Response) {
    try {
      const deleted = await projectService.deleteComment(param(req, "commentId"));
      if (!deleted) {
        return res.status(404).json({ success: false, error: "Comment not found" });
      }
      res.json({ success: true, message: "Comment deleted" });
    } catch (error) {
      console.error("Error deleting comment:", error);
      res.status(500).json({ success: false, error: "Failed to delete comment" });
    }
  }

  async getProjectFiles(req: Request, res: Response) {
    try {
      const files = await projectService.getProjectFiles(param(req, "id"));
      res.json({ success: true, data: files, count: files.length });
    } catch (error) {
      console.error("Error fetching project files:", error);
      res.status(500).json({ success: false, error: "Failed to fetch files" });
    }
  }

  async createFile(req: Request, res: Response) {
    try {
      const file = await projectService.createFile({
        projectId: param(req, "id"),
        name: req.body.name,
        type: req.body.type,
        phase: req.body.phase,
        url: req.body.url,
        size: req.body.size,
        uploadedBy: req.body.uploadedBy,
      });
      res.status(201).json({ success: true, data: file });
    } catch (error) {
      console.error("Error creating file:", error);
      res.status(500).json({ success: false, error: "Failed to create file" });
    }
  }

  // Step 1: get presigned URL to upload directly to S3 from browser
  async presignUpload(req: Request, res: Response) {
    try {
      const { filename, mimetype, phase, size } = req.body;
      if (!filename || !mimetype) {
        return res.status(400).json({ success: false, error: "filename and mimetype required" });
      }
      const projectId = param(req, "id");
      const { uploadUrl, fileUrl, key } = await generatePresignedUrl(projectId, filename, mimetype);
      res.json({ success: true, data: { uploadUrl, fileUrl, key, type: detectType(mimetype) } });
    } catch (error) {
      console.error("Error generating presigned URL:", error);
      res.status(500).json({ success: false, error: "Failed to generate upload URL" });
    }
  }

  // Step 2: after browser uploads to S3, save file record in DB
  async confirmUpload(req: Request, res: Response) {
    try {
      const { name, type, phase, url, s3Key, size } = req.body;
      if (!name || !url) {
        return res.status(400).json({ success: false, error: "name and url required" });
      }
      const file = await projectService.createFile({
        projectId: param(req, "id"),
        name,
        type,
        phase,
        url,
        s3Key,
        size,
        uploadedBy: getUserId(req),
      });
      res.status(201).json({ success: true, data: file });
    } catch (error) {
      console.error("Error confirming upload:", error);
      res.status(500).json({ success: false, error: "Failed to save file" });
    }
  }

  async deleteFile(req: Request, res: Response) {
    try {
      const s3Key = await projectService.deleteFile(param(req, "fileId"));
      if (s3Key === undefined) {
        return res.status(404).json({ success: false, error: "File not found" });
      }
      if (s3Key) {
        deleteFromS3(s3Key).catch((err) => console.error("S3 delete failed:", err));
      }
      res.json({ success: true, message: "File deleted successfully" });
    } catch (error) {
      console.error("Error deleting file:", error);
      res.status(500).json({ success: false, error: "Failed to delete file" });
    }
  }

  // Generate presigned download URL for a file
  async getFileDownloadUrl(req: Request, res: Response) {
    try {
      const fileId = param(req, "fileId");
      const file = await prisma.projectFile.findUnique({ where: { id: fileId } });
      if (!file) {
        return res.status(404).json({ success: false, error: "File not found" });
      }
      if (!file.s3Key) {
        return res.status(400).json({ success: false, error: "File has no S3 key" });
      }
      const downloadUrl = await generateDownloadUrl(file.s3Key, 3600);
      res.json({ success: true, data: { downloadUrl, filename: file.name, url: downloadUrl } });
    } catch (error) {
      console.error("Error generating download URL:", error);
      res.status(500).json({ success: false, error: "Failed to generate download URL" });
    }
  }

  async addDependency(req: Request, res: Response) {
    try {
      const blockedTaskId = param(req, "taskId");
      const { blockingTaskId } = req.body;
      if (!blockingTaskId) {
        return res.status(400).json({ success: false, error: "blockingTaskId is required" });
      }
      if (blockingTaskId === blockedTaskId) {
        return res.status(400).json({ success: false, error: "A task cannot block itself" });
      }
      await prisma.taskDependency.upsert({
        where: { blockingTaskId_blockedTaskId: { blockingTaskId, blockedTaskId } },
        update: {},
        create: { blockingTaskId, blockedTaskId, projectId: param(req, "id") },
      });
      res.status(201).json({ success: true });
    } catch (error) {
      console.error("Error adding dependency:", error);
      res.status(500).json({ success: false, error: "Failed to add dependency" });
    }
  }

  async removeDependency(req: Request, res: Response) {
    try {
      await prisma.taskDependency.deleteMany({
        where: {
          blockingTaskId: param(req, "blockingTaskId"),
          blockedTaskId: param(req, "taskId"),
        },
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Error removing dependency:", error);
      res.status(500).json({ success: false, error: "Failed to remove dependency" });
    }
  }

  // ── Checklist ────────────────────────────────────────────────────────────────

  async getChecklist(req: Request, res: Response) {
    try {
      const items = await prisma.taskChecklistItem.findMany({
        where: { taskId: param(req, "taskId") },
        orderBy: { position: "asc" },
      });
      res.json({ success: true, data: items });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to get checklist" });
    }
  }

  async addChecklistItem(req: Request, res: Response) {
    try {
      const { text } = req.body;
      if (!text) return res.status(400).json({ success: false, error: "text required" });
      const count = await prisma.taskChecklistItem.count({ where: { taskId: param(req, "taskId") } });
      const item = await prisma.taskChecklistItem.create({
        data: {
          taskId: param(req, "taskId"),
          projectId: param(req, "id"),
          text,
          position: count,
        },
      });
      res.json({ success: true, data: item });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to add checklist item" });
    }
  }

  async updateChecklistItem(req: Request, res: Response) {
    try {
      const itemId = param(req, "itemId");
      const { checked, text } = req.body;
      const item = await prisma.taskChecklistItem.update({
        where: { id: itemId },
        data: { ...(checked !== undefined ? { checked } : {}), ...(text !== undefined ? { text } : {}) },
      });
      res.json({ success: true, data: item });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to update checklist item" });
    }
  }

  async deleteChecklistItem(req: Request, res: Response) {
    try {
      await prisma.taskChecklistItem.delete({ where: { id: param(req, "itemId") } });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to delete checklist item" });
    }
  }

  // ── S3 Configuration Check ──────────────────────────────────────────────────

  async checkS3Config(req: Request, res: Response) {
    try {
      const config = {
        hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
        hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_REGION || "not set",
        bucket: process.env.AWS_S3_BUCKET_NAME || "not set",
        accessKeyLength: process.env.AWS_ACCESS_KEY_ID?.length || 0,
        isConfigured: !!(
          process.env.AWS_ACCESS_KEY_ID &&
          process.env.AWS_SECRET_ACCESS_KEY &&
          process.env.AWS_S3_BUCKET_NAME
        ),
      };
      res.json({ success: true, data: config });
    } catch (error) {
      console.error("Error checking S3 config:", error);
      res.status(500).json({ success: false, error: "Failed to check S3 config" });
    }
  }

  // ── Project Documents (AI-generated) ────────────────────────────────────────

  async getProjectDocuments(req: Request, res: Response) {
    try {
      const docs = await prisma.projectDocument.findMany({
        where: { projectId: param(req, "id") },
        orderBy: { createdAt: "desc" },
      });
      res.json({ success: true, data: docs });
    } catch (error) {
      console.error("Error fetching project documents:", error);
      res.status(500).json({ success: false, error: "Failed to fetch documents" });
    }
  }

  async createProjectDocument(req: Request, res: Response) {
    try {
      const { title, content, type } = req.body;
      const doc = await prisma.projectDocument.create({
        data: {
          projectId: param(req, "id"),
          title,
          content,
          type: type || "note",
          createdBy: getUserName(req),
        },
      });
      res.status(201).json({ success: true, data: doc });
    } catch (error) {
      console.error("Error creating project document:", error);
      res.status(500).json({ success: false, error: "Failed to create document" });
    }
  }

  async deleteProjectDocument(req: Request, res: Response) {
    try {
      await prisma.projectDocument.delete({ where: { id: param(req, "docId") } });
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting project document:", error);
      res.status(500).json({ success: false, error: "Failed to delete document" });
    }
  }

  // ── Global Documents ────────────────────────────────────────────────────────

  async getAllDocuments(req: Request, res: Response) {
    try {
      const userId = getUserId(req);
      // Get all files from projects where user is owner or member
      const files = await prisma.projectFile.findMany({
        where: {
          project: {
            OR: [
              { userId },
              { members: { some: { userId } } },
            ],
          },
        },
        include: {
          project: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: { updatedAt: "desc" },
      });
      
      res.json({
        success: true,
        data: files.map(f => ({
          ...f,
          projectName: f.project.name,
        })),
        count: files.length
      });
    } catch (error) {
      console.error("Error fetching all documents:", error);
      res.status(500).json({ success: false, error: "Failed to fetch documents" });
    }
  }

  async getGitCommits(req: Request, res: Response) {
    try {
      const project = await projectService.getProjectById(param(req, "id"), getUserId(req));
      if (!project?.githubUrl) {
        return res.status(400).json({ success: false, error: "No GitHub URL configured for this project" });
      }
      const branch = req.query.branch as string | undefined;
      const commits = await ProjectGitHubService.listCommits(project.githubUrl, branch);
      res.json({ success: true, data: commits });
    } catch (error) {
      console.error("Error fetching git commits:", error);
      res.status(500).json({ success: false, error: "Failed to fetch commits from GitHub" });
    }
  }

  async getGitBranches(req: Request, res: Response) {
    try {
      const project = await projectService.getProjectById(param(req, "id"), getUserId(req));
      if (!project?.githubUrl) {
        return res.status(400).json({ success: false, error: "No GitHub URL configured for this project" });
      }
      const branches = await ProjectGitHubService.listBranches(project.githubUrl);
      res.json({ success: true, data: branches });
    } catch (error) {
      console.error("Error fetching git branches:", error);
      res.status(500).json({ success: false, error: "Failed to fetch branches from GitHub" });
    }
  }

  async getGitPulls(req: Request, res: Response) {
    try {
      const project = await projectService.getProjectById(param(req, "id"), getUserId(req));
      if (!project?.githubUrl) {
        return res.status(400).json({ success: false, error: "No GitHub URL configured for this project" });
      }
      const pulls = await ProjectGitHubService.listAllPullRequests(project.githubUrl);
      res.json({ success: true, data: pulls });
    } catch (error) {
      console.error("Error fetching pull requests:", error);
      res.status(500).json({ success: false, error: "Failed to fetch pull requests from GitHub" });
    }
  }

  // ── Project Rules ─────────────────────────────────────────────────────────

  async createProjectRule(req: Request, res: Response) {
    try {
      const { title, description, priority } = req.body;
      if (!title) {
        return res.status(400).json({ success: false, error: "title is required" });
      }
      const rule = await projectService.createProjectRule({
        projectId: param(req, "id"),
        title,
        description: description || "",
        priority,
      });
      res.status(201).json({ success: true, data: rule });
    } catch (error) {
      console.error("Error creating project rule:", error);
      res.status(500).json({ success: false, error: "Failed to create rule" });
    }
  }

  async updateProjectRule(req: Request, res: Response) {
    try {
      const rule = await projectService.updateProjectRule(param(req, "ruleId"), req.body);
      if (!rule) {
        return res.status(404).json({ success: false, error: "Rule not found" });
      }
      res.json({ success: true, data: rule });
    } catch (error) {
      console.error("Error updating project rule:", error);
      res.status(500).json({ success: false, error: "Failed to update rule" });
    }
  }

  async deleteProjectRule(req: Request, res: Response) {
    try {
      const deleted = await projectService.deleteProjectRule(param(req, "ruleId"));
      if (!deleted) {
        return res.status(404).json({ success: false, error: "Rule not found" });
      }
      res.json({ success: true, message: "Rule deleted" });
    } catch (error) {
      console.error("Error deleting project rule:", error);
      res.status(500).json({ success: false, error: "Failed to delete rule" });
    }
  }

  // ── Project Decisions ──────────────────────────────────────────────────────

  async createProjectDecision(req: Request, res: Response) {
    try {
      const { title, description, impact, artifactId } = req.body;
      if (!title || !description) {
        return res.status(400).json({ success: false, error: "title and description are required" });
      }
      const decision = await projectService.createProjectDecision({
        projectId: param(req, "id"),
        title,
        description,
        impact,
        madeBy: getUserName(req),
        artifactId,
      });
      res.status(201).json({ success: true, data: decision });
    } catch (error) {
      console.error("Error creating project decision:", error);
      res.status(500).json({ success: false, error: "Failed to create decision" });
    }
  }

  async updateProjectDecision(req: Request, res: Response) {
    try {
      const decision = await projectService.updateProjectDecision(param(req, "decisionId"), req.body);
      if (!decision) {
        return res.status(404).json({ success: false, error: "Decision not found" });
      }
      res.json({ success: true, data: decision });
    } catch (error) {
      console.error("Error updating project decision:", error);
      res.status(500).json({ success: false, error: "Failed to update decision" });
    }
  }

  async deleteProjectDecision(req: Request, res: Response) {
    try {
      const deleted = await projectService.deleteProjectDecision(param(req, "decisionId"));
      if (!deleted) {
        return res.status(404).json({ success: false, error: "Decision not found" });
      }
      res.json({ success: true, message: "Decision deleted" });
    } catch (error) {
      console.error("Error deleting project decision:", error);
      res.status(500).json({ success: false, error: "Failed to delete decision" });
    }
  }

  // ── Memory Summary ─────────────────────────────────────────────────────────

  async saveMemorySummary(req: Request, res: Response) {
    try {
      const { summary } = req.body;
      if (!summary) {
        return res.status(400).json({ success: false, error: "summary is required" });
      }
      const result = await projectService.saveMemorySummary(param(req, "id"), summary);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error("Error saving memory summary:", error);
      res.status(500).json({ success: false, error: "Failed to save memory summary" });
    }
  }

  // ── Task Stats ─────────────────────────────────────────────────────────

  async getTaskStats(req: Request, res: Response) {
    try {
      const stats = await projectService.getTaskStats(param(req, "id"));
      res.json({ success: true, data: stats });
    } catch (error) {
      console.error("Error fetching task stats:", error);
      res.status(500).json({ success: false, error: "Failed to fetch task stats" });
    }
  }
}

