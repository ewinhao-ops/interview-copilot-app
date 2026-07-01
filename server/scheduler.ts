// 轻量定时器:每日 AI 初筛 + 每日数据库备份。不引入 cron 框架。
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { config } from "./config.js";
import { runDailyScreening } from "./services/daily-screening.js";

const HOUR = 3600 * 1000;

function msUntilNext(hourOfDay: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hourOfDay, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** 每天 SCREENING_HOUR 点跑初筛(默认 8 点)。 */
export function startDailyScreeningScheduler() {
  if (process.env.DISABLE_SCHEDULER === "1") return;
  const screeningHour = Number(process.env.SCREENING_HOUR || 8);
  const tick = async () => {
    try {
      const r = await runDailyScreening({});
      if (r.screened) console.log(`[scheduler] 每日初筛完成: ${r.screened} 人`);
    } catch (e) {
      console.error("[scheduler] 每日初筛失败", (e as Error).message);
    }
    setTimeout(tick, 24 * HOUR);
  };
  setTimeout(tick, msUntilNext(screeningHour));

  // 每日备份(调用独立脚本,避免和主进程争用)
  const backupHour = Number(process.env.BACKUP_HOUR || 4);
  const backupTick = () => {
    const script = resolve(config.rootDir, "scripts/backup-db.mjs");
    const child = spawn(process.execPath, [script], { stdio: "ignore", detached: true, env: process.env });
    child.unref();
    setTimeout(backupTick, 24 * HOUR);
  };
  setTimeout(backupTick, msUntilNext(backupHour));

  console.log(`[scheduler] 已排程: 每日 ${screeningHour}:00 初筛, ${backupHour}:00 备份`);
}
