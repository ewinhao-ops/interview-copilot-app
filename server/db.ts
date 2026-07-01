import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "migrations");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(dirname(config.databasePath), { recursive: true });
  db = new Database(config.databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // 高并发写入调优:WAL 下 synchronous=NORMAL 安全且大幅减少 fsync(写入快几倍);
  // busy_timeout 让偶发锁等待而不是直接报错。这些对"很多候选人同时作答"很关键。
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  runMigrations(db);
  return db;
}

function runMigrations(database: Database.Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  const applied = new Set(
    database.prepare("SELECT name FROM _migrations").all().map((r: any) => r.name as string)
  );
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const insert = database.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)");
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    // DDL + 记账放进同一事务:迁移文件里某条语句中途失败时整体回滚,避免"部分应用又没记账"
    // 导致下次重跑命中 duplicate column / already exists 而永久卡死(SQLite 的 DDL 也支持事务)。
    database.transaction(() => {
      database.exec(sql);
      insert.run(file, new Date().toISOString());
    })();
    // eslint-disable-next-line no-console
    console.log(`[db] applied migration ${file}`);
  }
}

// ── 小工具：json 字段读写 ──
export function toJson(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

export function fromJson<T = unknown>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export const nowIso = () => new Date().toISOString();

// ── settings 键值表读写 ──
export function getSetting<T = unknown>(key: string, fallback: T): T {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  return fromJson<T>(row.value, fallback);
}

export function setSetting(key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, JSON.stringify(value), nowIso());
}
