import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import dotenv from "dotenv";
import { errorHandler, requestLogger } from "./middleware";
import aiRoutes from "./routes/ai-routes";
import authRoutes from "./routes/auth-routes";
import adminRoutes from "./routes/admin-routes";
import projectRoutes from "./routes/project-routes";
import inviteRoutes from "./routes/invite-routes";
import { authenticateToken } from "./middleware/auth";

dotenv.config();

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

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Anka OS Backend server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🤖 AI API: http://localhost:${PORT}/api/ai`);
});

export default app;
