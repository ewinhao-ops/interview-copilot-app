// 日历:手动事件 CRUD。二面预约由前端另读 /api/bookings 汇总,不在此处。
import type { FastifyInstance, FastifyReply } from "fastify";
import * as Calendar from "../repo/calendar.js";

function ok(reply: FastifyReply, p: Record<string, unknown> = {}) { return reply.send({ ok: true, ...p }); }

export function registerCalendarRoutes(app: FastifyInstance) {
  // 列出区间内的手动事件(?from=YYYY-MM-DD&to=YYYY-MM-DD)
  app.get("/api/calendar-events", async (req, reply) => {
    const q = (req.query || {}) as any;
    const from = typeof q.from === "string" ? q.from : undefined;
    const to = typeof q.to === "string" ? q.to : undefined;
    return ok(reply, { events: Calendar.listEvents(from, to) });
  });

  // 新建 / 更新(带 id 即更新)
  app.post("/api/calendar-events", async (req, reply) => {
    const b = (req.body || {}) as any;
    const date = String(b.date || "").trim();
    const title = String(b.title || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply.code(400).send({ ok: false, error: "bad_date" });
    if (!title) return reply.code(400).send({ ok: false, error: "title_required" });
    const clean = (v: any) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : undefined);
    const time = (v: any) => (typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v.trim()) ? v.trim() : undefined);
    const event = Calendar.upsertEvent({
      id: b.id ? String(b.id) : undefined,
      date, title: title.slice(0, 200),
      startTime: time(b.startTime), endTime: time(b.endTime),
      type: ["interview", "comm", "note"].includes(b.type) ? b.type : "note",
      candidateId: clean(b.candidateId), candidateName: clean(b.candidateName), note: clean(b.note),
      outcome: ["录用", "不录用", "待定"].includes(b.outcome) ? b.outcome : undefined,
    });
    return ok(reply, { event });
  });

  app.delete("/api/calendar-events/:id", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    return ok(reply, { deleted: Calendar.removeEvent(id) });
  });
}
