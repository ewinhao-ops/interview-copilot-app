// 每日备份 SQLite 数据库,保留 30 天。VPS 上用 cron 或 server 内置定时器调用。
// 用法: node scripts/backup-db.mjs
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const dbPath = process.env.DATABASE_PATH || resolve(ROOT, "data", "interview.db");
const backupDir = process.env.BACKUP_DIR || resolve(ROOT, "backups");
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 30);

if (!existsSync(dbPath)) {
  console.error(`[backup] 数据库不存在: ${dbPath}`);
  process.exit(1);
}
mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = join(backupDir, `interview-${stamp}.db`);

// better-sqlite3 的在线备份(不锁库)
const db = new Database(dbPath, { readonly: true });
await db.backup(target);
db.close();
console.log(`[backup] 已备份 -> ${target}`);

// 清理超过保留期的旧备份
const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
let removed = 0;
for (const f of readdirSync(backupDir)) {
  if (!f.startsWith("interview-") || !f.endsWith(".db")) continue;
  const p = join(backupDir, f);
  if (statSync(p).mtimeMs < cutoff) { rmSync(p); removed++; }
}
if (removed) console.log(`[backup] 清理过期备份 ${removed} 个(保留 ${KEEP_DAYS} 天)`);
