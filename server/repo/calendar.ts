// 手动日历事件仓库(沟通记录 / 面试安排 / 其它)。二面预约不在此表,由日历页另读 bookings 汇总。
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "../db.js";

export interface CalEvent {
  id: string;
  date: string;          // YYYY-MM-DD
  startTime?: string;    // HH:MM
  endTime?: string;
  type: "interview" | "comm" | "note";
  title: string;
  candidateId?: string;
  candidateName?: string;
  note?: string;
  outcome?: "录用" | "不录用" | "待定"; // 面试日历上手动标注的结果(仅面试类用)
  createdAt: string;
  updatedAt: string;
}

function toJson(r: any): CalEvent {
  return {
    id: r.id, date: r.date, startTime: r.start_time || undefined, endTime: r.end_time || undefined,
    type: (["interview", "comm", "note"].includes(r.type) ? r.type : "note"),
    title: r.title, candidateId: r.candidate_id || undefined, candidateName: r.candidate_name || undefined,
    note: r.note || undefined, outcome: (["录用", "不录用", "待定"].includes(r.outcome) ? r.outcome : undefined),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** 列出某日期区间(含端点)的事件;不传则全部。 */
export function listEvents(from?: string, to?: string): CalEvent[] {
  const db = getDb();
  let sql = "SELECT * FROM calendar_events";
  const args: any[] = [];
  if (from && to) { sql += " WHERE date >= ? AND date <= ?"; args.push(from, to); }
  sql += " ORDER BY date ASC, COALESCE(NULLIF(start_time,''),'99:99') ASC";
  return (db.prepare(sql).all(...args) as any[]).map(toJson);
}

export function getEvent(id: string): CalEvent | null {
  const r = getDb().prepare("SELECT * FROM calendar_events WHERE id = ?").get(id);
  return r ? toJson(r) : null;
}

/** 新建或更新(传 id 即更新)。 */
export function upsertEvent(e: Partial<CalEvent> & { date: string; title: string }): CalEvent {
  const db = getDb();
  const now = nowIso();
  const id = e.id || `ev-${randomUUID().slice(0, 12)}`;
  const existing = e.id ? (db.prepare("SELECT created_at FROM calendar_events WHERE id = ?").get(e.id) as any) : null;
  db.prepare(
    `INSERT INTO calendar_events (id, date, start_time, end_time, type, title, candidate_id, candidate_name, note, outcome, created_at, updated_at)
     VALUES (@id, @date, @start_time, @end_time, @type, @title, @candidate_id, @candidate_name, @note, @outcome, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       date=excluded.date, start_time=excluded.start_time, end_time=excluded.end_time, type=excluded.type,
       title=excluded.title, candidate_id=excluded.candidate_id, candidate_name=excluded.candidate_name,
       note=excluded.note, outcome=excluded.outcome, updated_at=excluded.updated_at`
  ).run({
    id, date: e.date, start_time: e.startTime || null, end_time: e.endTime || null,
    type: e.type && ["interview", "comm", "note"].includes(e.type) ? e.type : "note",
    title: e.title, candidate_id: e.candidateId || null, candidate_name: e.candidateName || null,
    note: e.note || null, outcome: e.outcome && ["录用", "不录用", "待定"].includes(e.outcome) ? e.outcome : null,
    created_at: existing?.created_at ?? now, updated_at: now,
  });
  return getEvent(id)!;
}

export function removeEvent(id: string): boolean {
  return getDb().prepare("DELETE FROM calendar_events WHERE id = ?").run(id).changes > 0;
}
