// 一次性存量迁移:booking-store.json + 导出的 localStorage + 飞书简历库 -> SQLite。
// 幂等(全部 upsert),可重复运行。用法: npm run migrate
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Candidates from "../server/repo/candidates.js";
import * as Interviews from "../server/repo/interviews.js";
import * as Bookings from "../server/repo/bookings.js";
import { readFeishuResumeRecords } from "../server/feishu.js";

const ROOT = resolve(import.meta.dirname, "..");
const bookingStorePath = resolve(ROOT, ".dev-data/booking-store.json");
const localStoragePath = resolve(ROOT, "migration-source/electron-localstorage.json");

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}

const summary: Record<string, number> = {};
const bump = (k: string, n = 1) => { summary[k] = (summary[k] || 0) + n; };

// ── 1. 候选人:飞书(主) + localStorage resume-records(补) ──
function migrateCandidates() {
  // 飞书(best-effort,lark-cli 不可用就跳过)
  try {
    const records = readFeishuResumeRecords() as Array<any>;
    for (const r of records) {
      Candidates.upsertCandidate({
        feishuRecordId: r.feishuRecordId, bossName: r.bossName, name: r.name, role: r.role,
        resumeText: r.resumeText || "", resumePath: r.resumePath, source: "feishu",
        invitationStatus: r.invitationStatus, collectedDate: r.collectedDate,
        score: r.score, priority: r.priority,
      });
      bump("candidates_feishu");
    }
    console.log(`[迁移] 飞书简历库 -> candidates: ${summary.candidates_feishu || 0} 条`);
  } catch (e) {
    console.warn(`[迁移] 飞书读取跳过(lark-cli 不可用?): ${(e as Error).message.slice(0, 120)}`);
  }

  // localStorage resume-records 补充
  const ls = readJson<{ data?: Record<string, any> }>(localStoragePath, {});
  const resumeRecords: any[] = ls.data?.["interview-ops.resume-records.v1"] || [];
  for (const r of resumeRecords) {
    if (!r?.name) continue;
    Candidates.upsertCandidate({
      id: r.id, feishuRecordId: r.feishuRecordId, bossName: r.bossName, name: r.name, role: r.role,
      resumeText: r.resumeText || "", resumePath: r.resumePath,
      source: r.feishuRecordId ? "feishu" : "manual",
      invitationStatus: r.invitationStatus, collectedDate: r.collectedDate,
      score: r.score, priority: r.priority,
    });
    bump("candidates_localstorage");
  }
  console.log(`[迁移] localStorage resume-records -> candidates: ${summary.candidates_localstorage || 0} 条`);
}

// ── 2. 面试会话 + 逐题:booking-store.json(主),localStorage 兜底 ──
function migrateSessions() {
  const store = readJson<any>(bookingStorePath, {});
  const lsData = readJson<{ data?: Record<string, any> }>(localStoragePath, {}).data || {};
  const fromStore: any[] = Object.values(store.sessions || {});
  const fromLs: any[] = lsData["interview-ops.interview-sessions.v1"] || [];
  const byId = new Map<string, any>();
  for (const s of [...fromLs, ...fromStore]) if (s?.id) byId.set(s.id, s); // store 覆盖 ls
  for (const s of byId.values()) {
    if (!s.roomToken) s.roomToken = s.bookingRoomToken || s.candidateLinkToken || `room-${s.id}`;
    Interviews.upsertSession(s);
    bump("interviews");
    bump("questions", Array.isArray(s.questions) ? s.questions.length : 0);
  }
  console.log(`[迁移] 面试会话 -> interviews: ${summary.interviews || 0} 个,逐题 ${summary.questions || 0} 条`);
}

// ── 3. 预约 / 档期 / 预约链接 ──
function migrateBookings() {
  const store = readJson<any>(bookingStorePath, {});
  const lsData = readJson<{ data?: Record<string, any> }>(localStoragePath, {}).data || {};

  const bookings: any[] = [...(store.bookings || []), ...(lsData["interview-ops.public-bookings.v1"] || [])];
  const seenB = new Set<string>();
  for (const b of bookings) {
    if (!b?.id || seenB.has(b.id)) continue;
    seenB.add(b.id);
    Bookings.upsertBooking(b);
    bump("bookings");
  }

  const ranges: any[] = (store.ranges && store.ranges.length ? store.ranges : lsData["interview-ops.availability-ranges.v1"]) || [];
  if (ranges.length) { Bookings.replaceAvailability(ranges); bump("availability", ranges.length); }

  for (const [token, cfg] of Object.entries(store.links || {})) {
    Bookings.saveBookingLink(token, cfg as Record<string, unknown>);
    bump("booking_links");
  }
  console.log(`[迁移] 预约 ${summary.bookings || 0} 条,档期 ${summary.availability || 0} 个,预约链接 ${summary.booking_links || 0} 个`);
}

console.log("=== 开始迁移到 SQLite ===");
migrateCandidates();
migrateSessions();
migrateBookings();
console.log("=== 迁移完成 ===");
console.log(JSON.stringify(summary, null, 2));
