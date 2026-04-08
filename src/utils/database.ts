import sqlite3 from "sqlite3";
import { promisify } from "util";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const DB_PATH = join(process.cwd(), "data", "anka.db");

export class DatabaseService {
  private db: sqlite3.Database;

  constructor() {
    // Ensure data directory exists
    const dataDir = join(process.cwd(), "data");
    mkdirSync(dataDir, { recursive: true });

    this.db = new sqlite3.Database(DB_PATH);
    this.initialize();
  }

  private initialize() {
    // Create tables if they don't exist
    const schema = readFileSync(
      join(__dirname, "../database/schema.sql"),
      "utf8",
    );
    this.db.exec(schema);
  }

  async query(sql: string, params: any[] = []): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  async get(sql: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }

  async run(sql: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this);
        }
      });
    });
  }

  close() {
    this.db.close();
  }
}
