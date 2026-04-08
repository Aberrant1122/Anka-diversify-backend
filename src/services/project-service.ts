import { DatabaseService } from "../utils/database";
import { Project, Task } from "../types";

export class ProjectService {
  private db: DatabaseService;

  constructor() {
    this.db = new DatabaseService();
  }

  // Get all projects
  async getAllProjects(): Promise<Project[]> {
    try {
      const result = await this.db.query(`
        SELECT p.*, 
               COUNT(t.id) as task_count
        FROM projects p
        LEFT JOIN tasks t ON p.id = t.project_id
        GROUP BY p.id
        ORDER BY p.created_at DESC
      `);
      return result;
    } catch (error) {
      console.error("Error fetching projects:", error);
      throw error;
    }
  }

  // Get project by ID
  async getProjectById(id: string): Promise<Project | null> {
    try {
      const result = await this.db.query(
        `
        SELECT p.*, 
               COUNT(t.id) as task_count,
               GROUP_CONCAT(
                 JSON_OBJECT(
                   'id', t.id,
                   'title', t.title,
                   'status', t.status,
                   'priority', t.priority
                 )
               ) as tasks
        FROM projects p
        LEFT JOIN tasks t ON p.id = t.project_id
        WHERE p.id = ?
        GROUP BY p.id
      `,
        [id],
      );

      return result.length > 0 ? result[0] : null;
    } catch (error) {
      console.error("Error fetching project:", error);
      throw error;
    }
  }

  // Create new project
  async createProject(projectData: {
    name: string;
    description?: string;
    phase: string;
    priority: string;
    github_url?: string;
    start_date: string;
    due_date: string;
    status: string;
  }): Promise<Project> {
    try {
      const result = await this.db.query(
        `
        INSERT INTO projects (
          name, description, phase, priority, github_url, 
          start_date, due_date, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `,
        [
          projectData.name,
          projectData.description || null,
          projectData.phase,
          projectData.priority,
          projectData.github_url || null,
          projectData.start_date,
          projectData.due_date,
          projectData.status,
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );

      return result[0];
    } catch (error) {
      console.error("Error creating project:", error);
      throw error;
    }
  }

  // Update project
  async updateProject(
    id: string,
    updateData: {
      name?: string;
      description?: string;
      phase?: string;
      priority?: string;
      github_url?: string;
      status?: string;
    },
  ): Promise<Project | null> {
    try {
      const fields = [];
      const values = [];

      if (updateData.name !== undefined) {
        fields.push("name = ?");
        values.push(updateData.name);
      }
      if (updateData.description !== undefined) {
        fields.push("description = ?");
        values.push(updateData.description);
      }
      if (updateData.phase !== undefined) {
        fields.push("phase = ?");
        values.push(updateData.phase);
      }
      if (updateData.priority !== undefined) {
        fields.push("priority = ?");
        values.push(updateData.priority);
      }
      if (updateData.github_url !== undefined) {
        fields.push("github_url = ?");
        values.push(updateData.github_url);
      }
      if (updateData.status !== undefined) {
        fields.push("status = ?");
        values.push(updateData.status);
      }

      fields.push("updated_at = ?");
      values.push(new Date().toISOString());

      const result = await this.db.query(
        `
        UPDATE projects 
        SET ${fields.join(", ")}
        WHERE id = ?
        RETURNING *
      `,
        [...values, id],
      );

      return result.length > 0 ? result[0] : null;
    } catch (error) {
      console.error("Error updating project:", error);
      throw error;
    }
  }

  // Delete project
  async deleteProject(id: string): Promise<boolean> {
    try {
      await this.db.query("DELETE FROM projects WHERE id = ?", [id]);
      return true;
    } catch (error) {
      console.error("Error deleting project:", error);
      throw error;
    }
  }

  // Get project tasks
  async getProjectTasks(projectId: string): Promise<Task[]> {
    try {
      const result = await this.db.query(
        `
        SELECT * FROM tasks 
        WHERE project_id = ? 
        ORDER BY created_at DESC
      `,
        [projectId],
      );

      return result;
    } catch (error) {
      console.error("Error fetching project tasks:", error);
      throw error;
    }
  }

  // Create project task
  async createTask(taskData: {
    project_id: string;
    title: string;
    description?: string;
    status: string;
    priority: string;
    assignee_id?: string;
    due_date?: string;
  }): Promise<Task> {
    try {
      const result = await this.db.query(
        `
        INSERT INTO tasks (
          project_id, title, description, status, priority, 
          assignee_id, due_date, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `,
        [
          taskData.project_id,
          taskData.title,
          taskData.description || null,
          taskData.status,
          taskData.priority,
          taskData.assignee_id || null,
          taskData.due_date || null,
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );

      return result[0];
    } catch (error) {
      console.error("Error creating task:", error);
      throw error;
    }
  }

  // Get projects by phase
  async getProjectsByPhase(phase: string): Promise<Project[]> {
    try {
      const result = await this.db.query(
        `
        SELECT * FROM projects 
        WHERE phase = ? 
        ORDER BY created_at DESC
      `,
        [phase],
      );

      return result;
    } catch (error) {
      console.error("Error fetching projects by phase:", error);
      throw error;
    }
  }

  // Search projects
  async searchProjects(query: string): Promise<Project[]> {
    try {
      const result = await this.db.query(
        `
        SELECT * FROM projects 
        WHERE name LIKE ? OR description LIKE ?
        ORDER BY created_at DESC
      `,
        [`%${query}%`, `%${query}%`],
      );

      return result;
    } catch (error) {
      console.error("Error searching projects:", error);
      throw error;
    }
  }
}
