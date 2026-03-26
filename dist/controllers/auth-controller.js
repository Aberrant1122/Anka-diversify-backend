"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const database_1 = require("../services/database");
const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret";
class AuthController {
    async signup(req, res) {
        try {
            const { name, email, password, role } = req.body;
            if (!name || !email || !password || !role) {
                return res
                    .status(400)
                    .json({ message: "Name, email, password, and role are required" });
            }
            // Validate role
            const validRoles = ["admin", "user", "manager"];
            if (!validRoles.includes(role)) {
                return res
                    .status(400)
                    .json({ message: "Invalid role. Must be admin, user, or manager" });
            }
            // Check if user already exists
            const existingUser = await database_1.prisma.user.findUnique({
                where: { email },
            });
            if (existingUser) {
                return res
                    .status(400)
                    .json({ message: "User with this email already exists" });
            }
            // Hash password
            const saltRounds = 12;
            const hashedPassword = await bcryptjs_1.default.hash(password, saltRounds);
            // Create user
            const user = await database_1.prisma.user.create({
                data: {
                    name,
                    email,
                    password: hashedPassword,
                    role,
                },
            });
            // Generate JWT token
            const token = jsonwebtoken_1.default.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
            res.status(201).json({
                message: "User created successfully",
                token,
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    createdAt: user.createdAt,
                },
            });
        }
        catch (error) {
            console.error("Signup error:", error);
            res.status(500).json({ message: "Internal server error" });
        }
    }
    async login(req, res) {
        try {
            const { email, password } = req.body;
            if (!email || !password) {
                return res
                    .status(400)
                    .json({ message: "Email and password are required" });
            }
            // Find user
            const user = await database_1.prisma.user.findUnique({
                where: { email },
                select: {
                    id: true,
                    name: true,
                    email: true,
                    password: true,
                    role: true,
                    createdAt: true,
                    updatedAt: true,
                },
            });
            if (!user) {
                return res.status(401).json({ message: "Invalid email or password" });
            }
            // Check password
            const isPasswordValid = await bcryptjs_1.default.compare(password, user.password);
            if (!isPasswordValid) {
                return res.status(401).json({ message: "Invalid email or password" });
            }
            // Generate JWT token
            const token = jsonwebtoken_1.default.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
            res.json({
                message: "Login successful",
                token,
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    createdAt: user.createdAt,
                },
            });
        }
        catch (error) {
            console.error("Login error:", error);
            res.status(500).json({ message: "Internal server error" });
        }
    }
    async getProfile(req, res) {
        try {
            const userId = req.headers["x-user-id"];
            if (!userId) {
                return res.status(401).json({ message: "User ID required" });
            }
            const user = await database_1.prisma.user.findUnique({
                where: { id: userId },
                select: {
                    id: true,
                    name: true,
                    email: true,
                    createdAt: true,
                    updatedAt: true,
                },
            });
            if (!user) {
                return res.status(404).json({ message: "User not found" });
            }
            res.json({ user });
        }
        catch (error) {
            console.error("Get profile error:", error);
            res.status(500).json({ message: "Internal server error" });
        }
    }
}
exports.AuthController = AuthController;
//# sourceMappingURL=auth-controller.js.map