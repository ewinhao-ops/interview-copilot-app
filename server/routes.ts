// 所有 /api 路由。沿用旧接口路径,后端改 SQLite + Fastify。
// 候选人公开路由由 auth.ts 的 isPublicRoute 放行;其余需管理员会话。
import type { FastifyInstance, FastifyReply } from "fastify";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { maskedAiConfig, writeAiConfig } from "./ai.js";
import { generateResultReason } from "./services/interview-ai.js";
import { smsConfigured, sendResultSms } from "./services/sms.js";
import {
  readFeishuConfig, readFeishuResumeRecords, upsertFeishuRecord, sanitizeFeishuWriteFields,
  resolveFeishuRecordIdByName,
} from "./feishu.js";
import * as Candidates from "./repo/candidates.js";
import * as Interviews from "./repo/interviews.js";
import * as Bookings from "./repo/bookings.js";
import * as Screenings from "./repo/screenings.js";
import * as Evaluations from "./repo/evaluations.js";
import * as Attachments from "./repo/attachments.js";

function ok(reply: FastifyReply, payload: Record<string, unknown> = {}) {
  return reply.send({ ok: true, ...payload });
}

function resolveBookingRecordId(booking: Record<string, any>): string | null {
  const matched = typeof booking.matchedResumeId === "string" ? booking.matchedResumeId.replace(/^feishu-/, "") : "";
  if (matched.startsWith("rec")) return matched;
  return resolveFeishuRecordIdByName(typeof booking.candidateName === "string" ? booking.candidateName : "");
}

export function registerRoutes(app: FastifyInstance) {
  app.get("/api/health", async () => ({ ok: true, ts: new Date().toISOString() }));

  // ── AI 配置(设置页只读展示掩码;模型调用由服务端内部完成,不再有 /api/mimo/chat 代理) ──
  app.get("/api/ai-config", async (_req, reply) => ok(reply, { config: maskedAiConfig() }));
  app.post("/api/ai-config", async (req, reply) => {
    writeAiConfig((req.body || {}) as Record<string, unknown>);
    return ok(reply);
  });

  // ── 人才主表 ──
  app.get("/api/candidates", async (_req, reply) => ok(reply, { candidates: Candidates.listCandidates() }));
  // 单个候选人(详情页用,含完整简历)—— 免拉全表
  app.get("/api/candidates/:id", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const c = Candidates.getCandidate(id);
    if (!c) return reply.code(404).send({ ok: false, error: "candidate_not_found" });
    return ok(reply, { candidate: c });
  });
  // 某候选人最新一场面试 —— 免拉全部 session
  app.get("/api/candidates/:id/interview", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    return ok(reply, { interview: Interviews.getLatestSessionByCandidate(id) });
  });
  // 详情页一次性聚合(候选人+初筛+最新面试+评估+二面)—— 一个请求搞定,免多次往返
  app.get("/api/candidates/:id/detail", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const candidate = Candidates.getCandidate(id);
    if (!candidate) return reply.code(404).send({ ok: false, error: "candidate_not_found" });
    // 照片(base64 ~几十KB)从详情主体剥离,改懒加载;主体先秒出
    const { photo, ...candNoPhoto } = candidate as any;
    const screening = Screenings.getScreeningByCandidate(id);
    const interview = Interviews.getLatestSessionByCandidate(id);
    const evaluation = interview ? Evaluations.getEvaluationByInterview(interview.id) : null;
    const invite = Bookings.findSecondInviteByCandidate(id);
    const booking = Bookings.findBookingByCandidate(id);
    // 候选人上传的作品/答题图片(元数据 + 后台回放 url),详情页「候选人作品」卡片用
    const attachments = interview
      ? Attachments.listMeta(interview.id).map((a) => ({ ...a, url: `/api/interviews/${interview.id}/attachments/${a.id}/file` }))
      : [];
    return ok(reply, {
      candidate: { ...candNoPhoto, hasPhoto: !!photo }, screening, interview, evaluation, attachments,
      secondInterview: { invite: invite ? { token: invite.token, url: `/p/booking/${invite.token}`, ...invite.config } : null, booking },
    });
  });
  // 候选人照片(单独懒加载,避免拖慢详情主体)
  app.get("/api/candidates/:id/photo", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const c = Candidates.getCandidate(id);
    return ok(reply, { photo: c?.photo || null });
  });
  // 删除候选人(及其全部面试/题目/附件/评估/初筛 + 磁盘上的作品文件)
  app.delete("/api/candidates/:id", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    if (!Candidates.getCandidate(id)) return reply.code(404).send({ ok: false, error: "candidate_not_found" });
    const { filePaths } = Candidates.deleteCandidate(id);
    for (const fp of filePaths) {
      try { const p = join(config.uploadsDir, fp); if (existsSync(p)) unlinkSync(p); } catch { /* 文件清不掉不阻塞 */ }
    }
    return ok(reply, { deleted: true });
  });

  // 录用结果决定(通过/不通过 + 给候选人的说明)
  app.post("/api/candidates/:id/result", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    if (!Candidates.getCandidate(id)) return reply.code(404).send({ ok: false, error: "candidate_not_found" });
    const body = (req.body || {}) as any;
    const result = body.result === "pass" || body.result === "reject" ? body.result : null;
    Candidates.setCandidateResult(id, result, typeof body.note === "string" ? body.note.slice(0, 2000) : "");
    const cand: any = Candidates.getCandidate(id);
    // 结果短信:配置齐全 + 候选人填了手机号 时,发结果通知短信(纯文字模板,不带链接)
    let sms: { sent: boolean; reason?: string } = { sent: false };
    if (result && smsConfigured() && cand?.phone) {
      const r = await sendResultSms(cand.phone, result, cand.role || "应聘");
      sms = { sent: r.ok, reason: r.error };
    } else if (result && cand?.phone && !smsConfigured()) {
      sms = { sent: false, reason: "sms_not_configured" };
    } else if (result && !cand?.phone) {
      sms = { sent: false, reason: "no_phone" };
    }
    return ok(reply, { candidate: cand, sms });
  });

  // 后台手改候选人所在地(目前所在城市 / 期望城市)
  app.post("/api/candidates/:id/location", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    if (!Candidates.getCandidate(id)) return reply.code(404).send({ ok: false, error: "candidate_not_found" });
    const body = (req.body || {}) as any;
    const current = typeof body.current === "string" ? body.current : "";
    const expect = typeof body.expect === "string" ? body.expect : "";
    Candidates.setCandidateLocation(id, current, expect);
    return ok(reply, { candidate: Candidates.getCandidate(id) });
  });

  // 简历收藏(星标)开关
  app.post("/api/candidates/:id/star", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    if (!Candidates.getCandidate(id)) return reply.code(404).send({ ok: false, error: "candidate_not_found" });
    const starred = !!(req.body as any)?.starred;
    Candidates.setCandidateStarred(id, starred);
    return ok(reply, { starred });
  });
  // 结合综合评估,AI 生成给候选人看的"通过/不通过"通知文案(高随机度,可多次换一个)
  app.post("/api/candidates/:id/result-reason", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const c = Candidates.getCandidate(id);
    if (!c) return reply.code(404).send({ ok: false, error: "candidate_not_found" });
    const result = (req.body as any)?.result === "pass" ? "pass" : "reject";
    const iv = Interviews.getLatestSessionByCandidate(id);
    const ev: any = iv ? Evaluations.getEvaluationByInterview(iv.id) : null;
    const raw: any = ev?.raw || {};
    const sc: any = Screenings.getScreeningByCandidate(id);
    const note = await generateResultReason({
      candidateName: c.name, role: c.role, result,
      evalSummary: ev?.summary, evalGrade: ev?.grade,
      strengths: raw.strengths, concerns: raw.concerns, answersOverview: raw.answersOverview,
      screeningSummary: sc?.summary,
    });
    return ok(reply, { note });
  });
  app.post("/api/candidates", async (req, reply) => {
    const body = (req.body || {}) as Record<string, any>;
    if (!body.name) return reply.code(400).send({ ok: false, error: "name_required" });
    // 取第一个非空字符串(空串/空白当作未传,交给简历解析兜底,避免空占位顶掉解析值)
    const firstStr = (...xs: any[]) => { for (const x of xs) if (typeof x === "string" && x.trim()) return x.trim(); return undefined; };
    const id = Candidates.upsertCandidate({
      id: body.id, feishuRecordId: body.feishuRecordId, bossName: body.bossName, name: body.name,
      role: body.role, resumeText: body.resumeText, resumePath: body.resumePath,
      source: body.source || "boss", contactStatus: body.contactStatus,
      invitationStatus: body.invitationStatus, currentStage: body.currentStage,
      collectedDate: body.collectedDate, score: body.score, priority: body.priority,
      // 所在地:同步方若显式带城市字段则优先(兼容多种命名);否则由 upsert 从简历文本解析
      locationCurrent: firstStr(body.locationCurrent, body.currentCity, body["目前所在城市"], body["目前所在的城市"], body["现居城市"]),
      locationExpect: firstStr(body.locationExpect, body.expectCity, body["期望城市"], body["期望工作城市"]),
    });
    return ok(reply, { candidate: Candidates.getCandidate(id) });
  });

  // ── 飞书简历库(过渡期只读 + 受控回写) ──
  // 同步:从飞书读取简历并 upsert 进 candidates(按 feishuRecordId/姓名去重)。
  app.post("/api/feishu/resumes/sync", async (_req, reply) => {
    const cfg = readFeishuConfig();
    const records = readFeishuResumeRecords(cfg) as Array<any>;
    let imported = 0;
    for (const r of records) {
      if (!r?.name) continue;
      Candidates.upsertCandidate({
        feishuRecordId: r.feishuRecordId, bossName: r.bossName, name: r.name, role: r.role,
        resumeText: r.resumeText || "", resumePath: r.resumePath, source: "feishu",
        invitationStatus: r.invitationStatus, collectedDate: r.collectedDate, score: r.score, priority: r.priority,
        // 飞书「目前所在地」字段(feishu.ts 已解析为 currentLocation)显式带入,作为现居城市权威源
        locationCurrent: r.currentLocation,
      });
      imported++;
    }
    return ok(reply, { source: "feishu-bitable", tableUrl: cfg.table.url, imported, total: records.length });
  });

  // 系统读取简历的飞书「简历库」多维表格链接(供页面上一键打开)
  app.get("/api/feishu/resume-library", async (_req, reply) => {
    try {
      const cfg = readFeishuConfig();
      return ok(reply, { url: cfg.table.url, name: (cfg.table as any).name || "简历库" });
    } catch {
      return ok(reply, { url: null, name: "简历库" });
    }
  });

  app.patch("/api/resumes/:id/invitation", async (req, reply) => {
    const body = (req.body || {}) as Record<string, any>;
    if (typeof body.feishuRecordId === "string" && body.feishuRecordId.startsWith("rec")) {
      try {
        upsertFeishuRecord(body.feishuRecordId, { 邀约状态: "已发", 邀约时间: body.invitedAt || new Date().toISOString() });
      } catch { /* 飞书写回失败不阻断 */ }
    }
    return ok(reply);
  });

  app.post("/api/feishu/resumes/write", async (req, reply) => {
    const body = (req.body || {}) as Record<string, any>;
    const rawFields = body.fields && typeof body.fields === "object" ? body.fields : {};
    let recordId = typeof body.feishuRecordId === "string" ? body.feishuRecordId.replace(/^feishu-/, "") : "";
    if (!recordId.startsWith("rec")) recordId = resolveFeishuRecordIdByName(typeof body.name === "string" ? body.name : "") || "";
    const fields = sanitizeFeishuWriteFields(rawFields);
    let feishuSynced = false;
    try {
      if (recordId && Object.keys(fields).length) feishuSynced = upsertFeishuRecord(recordId, fields);
    } catch { /* ignore */ }
    return ok(reply, { feishuSynced, recordId: recordId || null });
  });

  // ── 预约链接 ──
  app.get("/api/booking-links/:token", async (req, reply) => {
    const token = decodeURIComponent((req.params as { token: string }).token);
    const link = Bookings.getBookingLink(token);
    if (!link) return reply.code(404).send({ ok: false, link: null });
    return ok(reply, { link: Bookings.withLiveRanges(link) });
  });
  app.post("/api/booking-links", async (req, reply) => {
    const body = (req.body || {}) as Record<string, any>;
    if (typeof body.token === "string") Bookings.saveBookingLink(body.token, body);
    return ok(reply);
  });

  // ── 预约 ──
  app.get("/api/bookings", async (_req, reply) => ok(reply, { bookings: Bookings.listBookings() }));
  app.post("/api/bookings", async (req, reply) => {
    const body = (req.body || {}) as Record<string, any>;
    let feishuSynced = false;
    if (typeof body.id === "string") {
      Bookings.upsertBooking(body);
      try {
        const recId = resolveBookingRecordId(body);
        const slot = (body.slot || {}) as Record<string, unknown>;
        if (recId) {
          const approved = body.reviewStatus === "approved";
          feishuSynced = upsertFeishuRecord(recId, {
            预约提交时间: String(body.submittedAt || new Date().toISOString()),
            面试日期: String(slot.date || ""), 开始时间: String(slot.start || ""), 结束时间: String(slot.end || ""),
            邀约状态: approved ? "已安排" : "已提交待确认", 面试状态: approved ? "已安排" : "待确认",
          });
        }
      } catch { /* ignore */ }
    }
    return ok(reply, { feishuSynced });
  });
  app.patch("/api/bookings/:id/review", async (req, reply) => {
    const id = decodeURIComponent((req.params as { id: string }).id);
    const body = (req.body || {}) as Record<string, any>;
    const booking = Bookings.getBooking(id) as Record<string, any> | null;
    Bookings.reviewBooking(id, String(body.reviewStatus || "pending"));
    // 二面确认/拒绝 -> 推进候选人阶段(确认=二面已确认,拒绝/改约=退回约二面中)。仅"淘汰"的人不再推进。
    if (booking?.candidateId) {
      try {
        const cand = Candidates.getCandidate(booking.candidateId);
        const next = body.reviewStatus === "approved" ? "second_confirmed" : body.reviewStatus === "rejected" ? "second_invited" : null;
        if (cand && cand.result !== "reject" && next) Candidates.upsertCandidate({ id: booking.candidateId, name: cand.name, currentStage: next });
      } catch { /* 阶段推进失败不影响二面确认本身 */ }
    }
    let feishuSynced = false;
    if (booking) {
      try {
        const recId = resolveBookingRecordId(booking);
        const slot = (booking.slot || {}) as Record<string, unknown>;
        if (recId && body.reviewStatus === "approved") {
          feishuSynced = upsertFeishuRecord(recId, {
            邀约状态: "已安排", 面试状态: "已安排",
            面试日期: String(slot.date || ""), 开始时间: String(slot.start || ""), 结束时间: String(slot.end || ""),
          });
        } else if (recId && body.reviewStatus === "rejected") {
          feishuSynced = upsertFeishuRecord(recId, { 邀约状态: "已发", 面试状态: "待确认", 面试日期: "", 开始时间: "", 结束时间: "" });
        }
      } catch { /* ignore */ }
    }
    return ok(reply, { feishuSynced });
  });

  // ── 开放档期 ──
  app.get("/api/availability-ranges", async (_req, reply) => ok(reply, { ranges: Bookings.listAvailability() }));
  app.post("/api/availability-ranges", async (req, reply) => {
    const body = (req.body || {}) as Record<string, any>;
    if (Array.isArray(body.ranges)) Bookings.replaceAvailability(body.ranges);
    return ok(reply);
  });

  // ── 面试会话(只读列表,供后台人才详情时间线用) ──
  // 旧的实时推题/逐题作答/房间状态接口已随实时管道一起删除,候选人作答走 /api/public/*。
  app.get("/api/interview-sessions", async (_req, reply) => ok(reply, { sessions: Interviews.listSessions() }));
}
