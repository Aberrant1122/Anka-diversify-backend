import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import dotenv from "dotenv";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
import { errorHandler, requestLogger } from "./middleware";
import aiRoutes from "./routes/ai-routes";
import authRoutes from "./routes/auth-routes";
import adminRoutes from "./routes/admin-routes";
import projectRoutes from "./routes/project-routes";
import inviteRoutes from "./routes/invite-routes";

dotenv.config({ override: true });

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(compression());
app.use(morgan("combined"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

// CORS configuration
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
      "X-User-ID",
      "X-User-Name",
    ],
  }),
);

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});

// API Routes
app.use("/api/ai", aiRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/invites", inviteRoutes);

// Error handler
app.use(errorHandler);

// ── HTTP server + WebSocket terminal ──────────────────────────────────────────

const httpServer = createServer(app);

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (ws, req) => {
  const shell = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "bash");

  // Resolve cwd from projectId → localPath if provided
  const params = new URL(req.url || "/", "http://localhost").searchParams;
  const projectId = params.get("projectId");
  let cwd = process.env.HOME || process.cwd();
  if (projectId) {
    try {
      const rows = await prisma.$queryRaw<{ localPath: string | null }[]>`SELECT "localPath" FROM projects WHERE id = ${projectId} LIMIT 1`;
      if (rows[0]?.localPath) cwd = rows[0].localPath;
    } catch { /* fallback to HOME */ }
  }

  let term: ReturnType<typeof pty.spawn> | null = null;
  try {
    term = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd,
      env: process.env as Record<string, string>,
    });

    term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "input" && term) term.write(msg.data);
        if (msg.type === "resize" && term) term.resize(Number(msg.cols), Number(msg.rows));
      } catch {
        // non-JSON — treat as raw input
        if (term) term.write(raw.toString());
      }
    });

    ws.on("close", () => { if (term) term.kill(); });
    ws.on("error", () => { if (term) term.kill(); });
  } catch (err) {
    console.error("PTY spawn failed:", err);
    ws.send("Terminal unavailable: " + (err instanceof Error ? err.message : String(err)));
    ws.close();
  }
});

// Intercept upgrade requests — only allow /terminal path
httpServer.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url || "/", `http://localhost`);
  if (pathname === "/terminal") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

httpServer.listen(PORT, () => {
  console.log(`🚀 Anka OS Backend server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🤖 AI API: http://localhost:${PORT}/api/ai`);
  console.log(`💻 Terminal WS: ws://localhost:${PORT}/terminal`);
});

export default app;
