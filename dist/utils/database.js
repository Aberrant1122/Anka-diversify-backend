"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseService = void 0;
const sqlite3_1 = __importDefault(require("sqlite3"));
const path_1 = require("path");
const fs_1 = require("fs");
const DB_PATH = (0, path_1.join)(process.cwd(), "data", "anka.db");
class DatabaseService {
    constructor() {
        // Ensure data directory exists
        const dataDir = (0, path_1.join)(process.cwd(), "data");
        (0, fs_1.mkdirSync)(dataDir, { recursive: true });
        this.db = new sqlite3_1.default.Database(DB_PATH);
        this.initialize();
    }
    initialize() {
        // Create tables if they don't exist
        const schema = (0, fs_1.readFileSync)((0, path_1.join)(__dirname, "../database/schema.sql"), "utf8");
        this.db.exec(schema);
    }
    async query(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(rows);
                }
            });
        });
    }
    async get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(row);
                }
            });
        });
    }
    async run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(this);
                }
            });
        });
    }
    close() {
        this.db.close();
    }
}
exports.DatabaseService = DatabaseService;
//# sourceMappingURL=database.js.map