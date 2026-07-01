// 二面预约:按候选人专属档期(不是全局)。
// 管理员从详情页日历圈选时间 -> 生成该候选人专属预约链接 -> 候选人挑一个 -> 管理员确认。
import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { nowIso } from "../db.js";
import * as Candidates from "../repo/candidates.js";
import * as Bookings from "../repo/bookings.js";
import * as Calendar from "../repo/calendar.js";

function ok(reply: FastifyReply, p: Record<string, unknown> = {}) { return reply.send({ ok: true, ...p }); }

// "HH:MM" 加分钟
function plusMin(t: string, min: number): string {
  const [h, m] = t.split(":").map(Number);
  const total = h * 60 + m + min;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// 排二面时的"已占用时段" = 其他候选人的二面预约 + 日历上手动加了具体时间的安排(避免和你已排的事撞车)。
// 日历事件只取定了开始时间的;没填结束时间的按占 30 分钟算(与二面圈选的最小粒度一致)。
function busySlots(exceptCandidateId: string): Array<{ date: string; start: string; end: string }> {
  const booked = Bookings.listBookedSlots(exceptCandidateId);
  const cal = Calendar.listEvents()
    .filter((e) => e.startTime)
    .map((e) => ({ date: e.date, start: e.startTime as string, end: e.endTime || plusMin(e.startTime as string, 30) }));
  return [...booked, ...cal];
}

// 两个时段是否冲突:同一天 + 时间区间有重叠("HH:MM" 同格式可直接字典序比较)。无 end 视为按 start 点对比。
function slotConflict(a: { date: string; start: string; end?: string }, b: { date: string; start: string; end: string }): boolean {
  if (a.date !== b.date) return false;
  const aEnd = a.end || a.start, bEnd = b.end || b.start;
  return a.start < bEnd && b.start < aEnd; // 区间重叠
}
function isSlotTaken(slot: any, booked: Array<{ date: string; start: string; end: string }>): boolean {
  return booked.some((bk) => slotConflict(slot, bk));
}

export function registerSecondInterviewRoutes(app: FastifyInstance) {
  // 管理员:给某候选人生成二面邀约(附圈选的时间段)
  app.post("/api/candidates/:id/second-invite", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const c = Candidates.getCandidate(id);
    if (!c) return reply.code(404).send({ ok: false, error: "candidate_not_found" });
    const body = (req.body || {}) as any;
    const slots = Array.isArray(body.slots) ? body.slots.filter((s: any) => s?.date && s?.start) : [];
    if (!slots.length) return reply.code(400).send({ ok: false, error: "slots_required" });

    // 复用已有的(若有)token,避免每次换链接
    const existing = Bookings.findSecondInviteByCandidate(id);
    const token = existing?.token || `bk-${randomUUID().slice(0, 12)}`;
    Bookings.saveBookingLink(token, {
      purpose: "second-interview",
      candidateId: id, candidateName: c.name, role: c.role,
      slots, pickedIndex: null, createdAt: nowIso(),
      meetingNote: body.meetingNote || "",
    });
    // 发起二面 -> 阶段进入"约二面中"(等候选人挑时间)。"通过(pass)"代表通过一面、给二面机会,所以不阻止;
    // 只有已"淘汰(reject)"的人才不再推进二面。这样二面进展能正确覆盖"通过"造成的阶段。
    if (c.result !== "reject") Candidates.upsertCandidate({ id, name: c.name, currentStage: "second_invited" });
    return ok(reply, { token, url: `/p/booking/${token}` });
  });

  // 管理员:查某候选人的二面预约状态(链接+候选人已挑的时间)
  app.get("/api/candidates/:id/second-interview", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const invite = Bookings.findSecondInviteByCandidate(id);
    const booking = Bookings.findBookingByCandidate(id);
    // 其他候选人的二面 + 日历手动安排已占用的时段,供管理端圈选时避开
    const bookedSlots = busySlots(id);
    return ok(reply, {
      invite: invite ? { token: invite.token, url: `/p/booking/${invite.token}`, ...invite.config } : null,
      booking,
      bookedSlots,
    });
  });

  // 候选人:打开二面预约链接,看到专属时间段
  app.get("/api/public/booking/:token", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const cfg = Bookings.getBookingLink(token) as any;
    if (!cfg || cfg.purpose !== "second-interview") return reply.code(404).send({ ok: false, error: "not_found" });
    // 标注哪些时段已被占用(别的候选人二面 + 日历手动安排;排除本人),前端置灰、不可选
    const booked = busySlots(cfg.candidateId);
    const slots = (cfg.slots || []).map((s: any) => ({ ...s, taken: isSlotTaken(s, booked) }));
    return ok(reply, { candidateName: cfg.candidateName, slots, pickedIndex: cfg.pickedIndex ?? null });
  });

  // 候选人:挑一个时间
  app.post("/api/public/booking/:token/pick", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const cfg = Bookings.getBookingLink(token) as any;
    if (!cfg || cfg.purpose !== "second-interview") return reply.code(404).send({ ok: false, error: "not_found" });
    const body = (req.body || {}) as any;
    const idx = Number(body.index);
    const slot = cfg.slots?.[idx];
    if (!slot) return reply.code(400).send({ ok: false, error: "invalid_slot" });
    // 并发/重复占用防护:挑选时再次校验该时段没被占用(其他候选人二面 + 日历安排;排除本人之前的占用)
    const booked = busySlots(cfg.candidateId);
    if (isSlotTaken(slot, booked)) return reply.code(409).send({ ok: false, error: "slot_taken" });
    Bookings.saveBookingLink(token, { ...cfg, pickedIndex: idx });
    const bookingId = `bk-${cfg.candidateId}`;
    Bookings.upsertBooking({
      id: bookingId, candidateId: cfg.candidateId, candidateName: cfg.candidateName,
      token, slot, reviewStatus: "pending", submittedAt: nowIso(),
    });
    // 候选人挑了时间 -> 阶段进入"二面待确认"(等管理员确认)。淘汰的人不再推进。
    // name 用库里当前姓名(cand.name),不要用 booking 链接里冻结的旧值,避免把候选人姓名覆写回旧值。
    try {
      const cand = Candidates.getCandidate(cfg.candidateId);
      if (cand && cand.result !== "reject") Candidates.upsertCandidate({ id: cfg.candidateId, name: cand.name, currentStage: "second_picked" });
    } catch { /* 阶段推进失败不影响候选人挑时间本身 */ }
    return ok(reply, { picked: slot });
  });
}
