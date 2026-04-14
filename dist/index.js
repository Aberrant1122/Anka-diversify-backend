"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const compression_1 = __importDefault(require("compression"));
const dotenv_1 = __importDefault(require("dotenv"));
const middleware_1 = require("./middleware");
const ai_routes_1 = __importDefault(require("./routes/ai-routes"));
const auth_routes_1 = __importDefault(require("./routes/auth-routes"));
const admin_routes_1 = __importDefault(require("./routes/admin-routes"));
const project_routes_1 = __importDefault(require("./routes/project-routes"));
const invite_routes_1 = __importDefault(require("./routes/invite-routes"));
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3001;
// Middleware
app.use((0, helmet_1.default)());
app.use((0, compression_1.default)());
app.use((0, morgan_1.default)("combined"));
app.use(express_1.default.json({ limit: "10mb" }));
app.use(express_1.default.urlencoded({ extended: true }));
app.use(middleware_1.requestLogger);
// CORS configuration
app.use((0, cors_1.default)({
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
}));
// Health check
app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
    });
});
// API Routes
app.use("/api/ai", ai_routes_1.default);
app.use("/api/auth", auth_routes_1.default);
app.use("/api/admin", admin_routes_1.default);
app.use("/api/projects", project_routes_1.default);
app.use("/api/invites", invite_routes_1.default);
// Error handler
app.use(middleware_1.errorHandler);
// Start server
app.listen(PORT, () => {
    console.log(`🚀 Anka OS Backend server running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`🤖 AI API: http://localhost:${PORT}/api/ai`);
});
exports.default = app;
//# sourceMappingURL=index.js.map