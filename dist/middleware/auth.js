"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = exports.authenticateToken = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret";
const authenticateToken = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace("Bearer ", "");
        if (!token) {
            return res.status(401).json({ message: "No token provided" });
        }
        try {
            const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
            // Attach user info to request
            req.user = decoded;
            next();
        }
        catch (error) {
            return res.status(401).json({ message: "Invalid token" });
        }
    }
    catch (error) {
        return res.status(500).json({ message: "Server error" });
    }
};
exports.authenticateToken = authenticateToken;
const requireAuth = (req, res, next) => {
    (0, exports.authenticateToken)(req, res, next);
};
exports.requireAuth = requireAuth;
//# sourceMappingURL=auth.js.map