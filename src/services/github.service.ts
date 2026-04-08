import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SKIP_DIRS = ["node_modules", ".git", ".next", "dist", "build", ".cache", "coverage", "__pycache__", ".venv", "vendor"];
const SKIP_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".map", ".lock", ".bin", ".exe", ".dll", ".so", ".dylib", ".zip", ".tar", ".gz"];
const KEY_FILE_NAMES = ["README.md", "package.json", "tsconfig.json", "prisma/schema.prisma", ".env.example", "docker-compose.yml", "Makefile", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml"];
const ENTRY_PATTERN = /^(src\/)?(index|main|app|server)\.(ts|js|tsx|jsx|py|go|rs)$/;
const MAX_KEY_FILES = 15;
const MAX_FILE_CONTENT = 3000; // chars per file
const MAX_FILE_TREE = 500;

interface RepoFile {
  path: string;
  content: string;
}

export interface RepoSnapshot {
  repoName: string;
  defaultBranch: string;
  description: string;
  languages: Record<string, number>;
  fileTree: string[];
  keyFiles: RepoFile[];
  lastSyncedAt: Date;
}

function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  try {
    const parsed = new URL(url.trim());
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
    }
  } catch {}
  return null;
}

async function fetchGitHub(path: string): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "anka-os-backend",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${path}`);
  }
  return res.json();
}

function shouldSkip(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (SKIP_DIRS.some((d) => lower.startsWith(`${d}/`) || lower.includes(`/${d}/`))) return true;
  if (SKIP_EXTS.some((e) => lower.endsWith(e))) return true;
  return false;
}

export async function fetchRepoSnapshot(githubUrl: string): Promise<RepoSnapshot> {
  const parsed = parseGithubUrl(githubUrl);
  if (!parsed) throw new Error("Invalid GitHub URL");

  const { owner, repo } = parsed;

  const repoData = await fetchGitHub(`/repos/${owner}/${repo}`) as any;
  const defaultBranch: string = repoData.default_branch || "main";

  const [languages, treeDataFetched] = await Promise.all([
    fetchGitHub(`/repos/${owner}/${repo}/languages`) as Promise<Record<string, number>>,
    fetchGitHub(`/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`) as Promise<any>,
  ]);

  const allFiles: string[] = ((treeDataFetched.tree as any[]) || [])
    .filter((f) => f.type === "blob")
    .map((f) => f.path as string)
    .filter((p) => !shouldSkip(p))
    .slice(0, MAX_FILE_TREE);

  // Determine which files to fetch content for
  const priority: string[] = [
    ...allFiles.filter((f) => KEY_FILE_NAMES.includes(f)),
    ...allFiles.filter((f) => ENTRY_PATTERN.test(f)),
  ];
  const filesToFetch = [...new Set(priority)].slice(0, MAX_KEY_FILES);

  const keyFiles: RepoFile[] = [];
  for (const filePath of filesToFetch) {
    try {
      const fileData = await fetchGitHub(
        `/repos/${owner}/${repo}/contents/${filePath}?ref=${defaultBranch}`,
      ) as any;
      if (fileData.content) {
        const content = Buffer.from(fileData.content, "base64")
          .toString("utf-8")
          .slice(0, MAX_FILE_CONTENT);
        keyFiles.push({ path: filePath, content });
      }
    } catch {
      // skip inaccessible files silently
    }
  }

  return {
    repoName: `${owner}/${repo}`,
    defaultBranch,
    description: (repoData as any).description || "",
    languages,
    fileTree: allFiles,
    keyFiles,
    lastSyncedAt: new Date(),
  };
}

export class ProjectGitHubService {
  static async buildProjectContext(projectId: string, githubUrl: string): Promise<void> {
    const snapshot = await fetchRepoSnapshot(githubUrl);

    await prisma.projectRepoSnapshot.upsert({
      where: { projectId },
      create: {
        projectId,
        githubUrl,
        repoName: snapshot.repoName,
        defaultBranch: snapshot.defaultBranch,
        description: snapshot.description,
        fileTree: JSON.stringify(snapshot.fileTree),
        languages: JSON.stringify(snapshot.languages),
        keyFiles: JSON.stringify(snapshot.keyFiles),
      },
      update: {
        githubUrl,
        repoName: snapshot.repoName,
        defaultBranch: snapshot.defaultBranch,
        description: snapshot.description,
        fileTree: JSON.stringify(snapshot.fileTree),
        languages: JSON.stringify(snapshot.languages),
        keyFiles: JSON.stringify(snapshot.keyFiles),
        lastSyncedAt: new Date(),
      },
    });
  }

  static async getSnapshot(projectId: string): Promise<RepoSnapshot | null> {
    const row = await prisma.projectRepoSnapshot.findUnique({
      where: { projectId },
    });
    if (!row) return null;

    return {
      repoName: row.repoName,
      defaultBranch: row.defaultBranch,
      description: row.description,
      languages: JSON.parse(row.languages),
      fileTree: JSON.parse(row.fileTree),
      keyFiles: JSON.parse(row.keyFiles),
      lastSyncedAt: row.lastSyncedAt,
    };
  }
}
