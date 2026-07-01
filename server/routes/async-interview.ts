// 阶段2 异步面试:候选人公开入口(/api/public/*) + 后台编排(创建/评判/报告)。
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { createReadStream, statSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import * as Interviews from "../repo/interviews.js";
import * as Candidates from "../repo/candidates.js";
import * as Evaluations from "../repo/evaluations.js";
import { transcribeAudio } from "../services/transcribe.js";
import { cosConfigured, cosPutObject, cosGetObject, cosDeleteObject } from "../services/cos.js";
import * as Calendar from "../repo/calendar.js";
import { judgeAnswer, generateReport, polishAnswer, compareCandidates, type CompareCandidateInput, type QuestionJudgement } from "../services/interview-ai.js";
import { getConfig, saveConfig, isVideoCreatorRole } from "../services/job-profile.js";
import { backgroundSignalForPrompt, detectTeachingIp } from "../services/education.js";
import * as Attachments from "../repo/attachments.js";
import { getSetting, setSetting } from "../db.js";

// ───────── 作品附件:落盘 + 流式回放(支持视频 Range 拖动) ─────────
const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/heic": ".heic", "image/avif": ".avif",
  "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-msvideo": ".avi", "video/x-matroska": ".mkv", "video/3gpp": ".3gp",
};
function extForMime(mime: string): string {
  const m = (mime || "").toLowerCase().split(";")[0].trim();
  if (MIME_EXT[m]) return MIME_EXT[m];
  const sub = m.split("/")[1] || "";
  const clean = sub.replace(/[^a-z0-9]+/g, "").slice(0, 8);
  return clean ? "." + clean : ".bin";
}
function worksPath(file: string): string { return join(config.uploadsDir, file); }

// 回放白名单:只让浏览器以这些类型渲染;其它(尤其 image/svg+xml 可执行脚本)一律降级为
// application/octet-stream(直接导航会触发下载而非当文档执行),配合 nosniff 杜绝存储型 XSS。
const SAFE_IMAGE = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/heic", "image/avif"]);
const SAFE_VIDEO = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-msvideo", "video/x-matroska", "video/3gpp", "video/3gpp2"]);
function safeContentType(mime: string): string {
  const m = (mime || "").toLowerCase().split(";")[0].trim();
  return SAFE_IMAGE.has(m) || SAFE_VIDEO.has(m) ? m : "application/octet-stream";
}
/** 是否危险图片类型(可被浏览器当文档执行脚本),上传入口直接拒绝。 */
function isDangerousImageMime(mime: string): boolean {
  const m = (mime || "").toLowerCase();
  return m.includes("svg") || m.includes("xml") || m.includes("html");
}

/** 流式回放磁盘文件(图片/视频),支持 HTTP Range(视频可拖动)。 */
function streamFile(req: FastifyRequest, reply: FastifyReply, absPath: string, mime: string) {
  let stat;
  try { stat = statSync(absPath); } catch { return reply.code(404).send({ ok: false, error: "file_missing" }); }
  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", safeContentType(mime));
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Cache-Control", "private, max-age=3600");
  const range = String(req.headers["range"] || "");
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) return reply.code(416).header("Content-Range", `bytes */${stat.size}`).send();
    reply.code(206).header("Content-Range", `bytes ${start}-${end}/${stat.size}`).header("Content-Length", end - start + 1);
    return reply.send(createReadStream(absPath, { start, end }));
  }
  reply.header("Content-Length", stat.size);
  return reply.send(createReadStream(absPath));
}

/** 把一个附件按其存储方式回放(落盘文件走 streamFile;旧的 data_url 内联图解码回放)。 */
export function sendAttachment(req: FastifyRequest, reply: FastifyReply, att: Attachments.AttachmentRow) {
  if (att.file_path) return streamFile(req, reply, worksPath(att.file_path), att.mime || "application/octet-stream");
  if (att.data_url && att.data_url.startsWith("data:")) {
    const comma = att.data_url.indexOf(",");
    if (comma < 0) return reply.code(404).send({ ok: false, error: "bad_data_url" });
    const meta = att.data_url.slice(5, comma); // e.g. image/jpeg;base64
    const mime = meta.split(";")[0] || "application/octet-stream";
    const buf = Buffer.from(att.data_url.slice(comma + 1), "base64");
    // 不信任存储的子类型:强制安全 Content-Type + nosniff,防止历史脏数据里的 svg/html 被当文档执行
    reply.header("Content-Type", safeContentType(mime)).header("X-Content-Type-Options", "nosniff").header("Cache-Control", "private, max-age=3600");
    return reply.send(buf);
  }
  return reply.code(404).send({ ok: false, error: "no_content" });
}

/** 面试品牌(公司名)—— 显示在候选人面试页;在 settings 表 key='brand' 可改。 */
function getBrand(): { companyName: string; tagline: string } {
  return getSetting("brand", { companyName: "AI 面试", tagline: "AI 智能面试" });
}

/** 面试设置:
 *  - answerLimitSec:每题回答时长上限(秒),0 = 不限时(全靠候选人手动结束);
 *  - maxDurationMin:整场面试从开始作答起的总时长上限(分钟),0 = 不限。超时该轮即结束、链接作废;
 *  - inviteTtlHours:邀约链接有效期(小时),候选人需在此时间内点开并开始(默认 48)。 */
function getInterviewSettings(): { answerLimitSec: number; maxDurationMin: number; inviteTtlHours: number } {
  const s = getSetting("interview_settings", {}) as any;
  const a = Number(s?.answerLimitSec);
  const d = Number(s?.maxDurationMin);
  const t = Number(s?.inviteTtlHours);
  return {
    answerLimitSec: Number.isFinite(a) && a >= 0 ? Math.round(a) : 240,
    maxDurationMin: Number.isFinite(d) && d >= 0 ? Math.round(d) : 60,
    inviteTtlHours: Number.isFinite(t) && t > 0 ? Math.round(t) : config.inviteTtlHours,
  };
}

// 一次性闸门:链接只用一次。已完成/已终止 -> completed;已开始(in_progress)但超总时长上限、
// 或离开超过宽限期 -> locked(本轮结束,需后台「重新开启」)。宽限期容忍误刷新/短暂断网。
const GRACE_MS = 10 * 60 * 1000;
function evalGate(session: any, maxDurationMin: number): { gate: "ok" | "completed" | "locked"; deadlineAt?: string } {
  if (session.status === "completed") return { gate: "completed" };
  if (session.status === "terminated") return { gate: "locked" };
  if (session.status === "in_progress") {
    const entered = session.candidateEnteredAt ? new Date(session.candidateEnteredAt).getTime() : 0;
    const last = session.candidateLastSeenAt ? new Date(session.candidateLastSeenAt).getTime() : 0;
    const deadline = maxDurationMin > 0 && entered ? entered + maxDurationMin * 60 * 1000 : 0;
    if (deadline && Date.now() > deadline) return { gate: "locked" };        // 总时长到点 -> 本轮结束
    if (last && Date.now() - last > GRACE_MS) return { gate: "locked" };     // 长时间离开 -> 本轮结束
    return { gate: "ok", deadlineAt: deadline ? new Date(deadline).toISOString() : undefined };
  }
  return { gate: "ok" }; // ready:尚未开始,不设截止
}

/** 把会话 + 题目状态汇成给后台看的"实时进度"。 */
function deriveLive(session: any) {
  const settings = getInterviewSettings();
  const { gate, deadlineAt } = evalGate(session, settings.maxDurationMin);
  const questions: any[] = Array.isArray(session.questions) ? session.questions : [];
  const total = questions.length;
  const answered = questions.filter((q) => q.status === "answered").length;
  const lastSeenAt = session.candidateLastSeenAt || null;
  const lastSeenMs = lastSeenAt ? new Date(lastSeenAt).getTime() : 0;
  const stage = session.candidateStage || "";
  const everSeen = Boolean(lastSeenAt || stage);

  // 当前所在题(优先正在看的题,否则下一道未答题)
  const viewing = session.candidateViewingQuestionId || session.currentQuestionId || "";
  let qIdx = questions.findIndex((q) => q.questionId === viewing);
  if (qIdx < 0) qIdx = Math.min(answered, Math.max(0, total - 1));
  const curQ = questions[qIdx];
  const recording = curQ && curQ.status === "recording";

  // step:粗粒度步骤 1..5,用于"第几步"展示
  let step = 0, stepLabel = "", detail = "";
  if (session.status === "completed") { step = 5; stepLabel = "已提交"; detail = "候选人已提交,等待/已完成评估"; }
  else if (gate === "locked" || session.status === "terminated") { step = 0; stepLabel = "已结束"; detail = "本轮已结束(超时 / 中途离开 / 手动结束)"; }
  else if (!everSeen) { step = 0; stepLabel = "未开始"; detail = "尚未开始 —— 等待候选人打开链接"; }
  else if (stage === "device") { step = 1; stepLabel = "设备检测"; detail = "正在检测设备(测试麦克风)"; }
  else if (stage === "photo") { step = 2; stepLabel = "拍照"; detail = "正在拍照采集本人照片"; }
  else if (stage === "works") { step = 4; stepLabel = "上传作品"; detail = "正在上传代表作品"; }
  else { step = 3; stepLabel = `第 ${qIdx + 1}/${total} 题`; detail = `正在答第 ${qIdx + 1} / ${total} 题(${recording ? "录音中" : "读题 / 作答中"})`; }

  const online = (gate === "ok") && lastSeenMs > 0 && (Date.now() - lastSeenMs < 75 * 1000);
  // 任何一题已收到录音或已有转写,都算"有作答痕迹"(用于一键清理时区分真未响应)
  const received = questions.filter((q) => (q.audioReceived || 0) > 0 || (q.correctedTranscript || "").trim()).length;
  return {
    hasInterview: true,
    interviewId: session.id,
    status: session.status,
    gate,
    deadlineAt: deadlineAt || null,
    stage: stage || null,
    step, stepLabel, detail,
    questionIndex: step === 3 ? qIdx + 1 : null,
    questionTotal: total,
    answeredCount: answered,
    receivedCount: received,
    everSeen,
    lastSeenAt,
    online,
    hasPhoto: undefined as boolean | undefined, // 由路由补
  };
}

/** 候选人全部答完后,后台异步收尾:逐题评判 + 生成报告(不阻塞候选人)。
 *  会先等末题的后台转写完成(最多 ~30s)。 */
async function finalizeInterview(sessionId: string, opts: { wait?: boolean } = {}): Promise<void> {
  const session = Interviews.getSession(sessionId);
  if (!session) return;
  // 等转写:对有回执但还没转写文本的题,轮询等待(末题刚录完时转写可能在途)。后台收尾用;管理员手动生成报告时不等。
  if (opts.wait !== false) {
    for (let i = 0; i < 15; i++) {
      const rows = Interviews.listQuestionRows(sessionId);
      const pending = rows.filter((r) => (r.audio_received || 0) > 0 && !(r.answer_transcript || "").trim());
      if (pending.length === 0) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const role = session.candidateRole;
  const rowsNow = Interviews.listQuestionRows(sessionId);
  // 并行评判(有转写、还没评过的)
  const toJudge = rowsNow.filter((r) => (r.answer_transcript || "").trim() && !r.judge_grade);
  // 并行整理回答(逻辑重排+改错字+小结):有转写、还没整理过的(历史面试 answer_summary 为空也会补)
  const toPolish = rowsNow.filter((r) => (r.answer_transcript || "").trim() && !(r.answer_summary || "").trim());
  await Promise.all([
    ...toJudge.map(async (r) => {
      try {
        const judge = await judgeAnswer({ question: r.prompt, dimension: r.dimension || undefined, transcript: r.answer_transcript || "", role });
        Interviews.setQuestionJudgement(sessionId, r.question_id, judge);
      } catch { /* 留待后台重跑 */ }
    }),
    ...toPolish.map(async (r) => {
      try {
        const text = await polishAnswer({ question: r.prompt, dimension: r.dimension || undefined, transcript: r.answer_transcript || "", role });
        if (text) Interviews.setQuestionAnswerSummary(sessionId, r.question_id, text);
      } catch { /* 留待后台重跑 */ }
    }),
  ]);
  // 生成总报告(含回答整体内容总结)
  try {
    const questions = Interviews.listQuestionRows(sessionId).map((r) => ({
      question: r.prompt, dimension: r.dimension || undefined, transcript: r.answer_transcript || "", answerSummary: r.answer_summary || "",
      judge: (r.judge_grade
        ? { grade: r.judge_grade, score: r.judge_score || "", quotes: JSON.parse(r.judge_quotes || "[]"), gaps: JSON.parse(r.judge_gaps || "[]"), summary: r.judge_summary || "" }
        : undefined) as QuestionJudgement | undefined,
    }));
    // 综合加分背景(学历 / 徐州本地 / 教学·IP)纳入报告评级
    let background = "";
    if (session.candidateId) {
      const c = Candidates.getCandidate(session.candidateId) as any;
      if (c) {
        const edu = { schoolTier: c.eduSchoolTier || "", schoolName: c.eduSchoolName || "", degree: c.eduDegree || "", postgrad: !!c.eduPostgrad };
        background = backgroundSignalForPrompt(edu as any, !!c.isLocal, detectTeachingIp(c.resumeText || ""));
      }
    }
    const report = await generateReport({ candidateName: session.candidateName || "候选人", role, background, questions });
    Evaluations.saveEvaluation({
      interviewId: sessionId, candidateId: session.candidateId, summary: report.summary,
      recommendation: report.recommendation, grade: report.grade,
      reviewChecklist: report.reviewChecklist, raw: report as unknown as Record<string, unknown>,
    });
    if (session.candidateId) {
      // 已进入二面或已下结论的候选人,重新生成一面报告时不要把阶段拖回"待决定"
      const cand = Candidates.getCandidate(session.candidateId);
      const stage = Candidates.isPostReview(cand?.currentStage) ? cand!.currentStage : "reviewed";
      try { Candidates.upsertCandidate({ id: session.candidateId, name: session.candidateName || "候选人", invitationStatus: "evaluated", currentStage: stage, priority: report.grade }); } catch { /* ignore */ }
    }
  } catch { /* 报告失败可后台「重新生成报告」 */ }
}

const gunzipAsync = promisify(gunzip);

/** 后台处理一段录音:异步解压(不占事件循环)+ 转写 -> 写回该题。fire-and-forget,候选人不等待。
 *  version 为收到此录音时的答案版本;转写写回时校验版本,避免候选人重答后旧转写覆盖新录音。 */
function processAudioAnswer(sessionId: string, qid: string, raw: Buffer, isGzip: boolean, sampleRate: number, version: number): void {
  void (async () => {
    let audio: Buffer | null = null;
    try {
      audio = isGzip ? Buffer.from(await gunzipAsync(raw)) : raw;
      if (!audio.length) return;
      const r = await transcribeAudio({ audio, format: "pcm", sampleRate });
      if (r.ok && r.text) { Interviews.setQuestionTranscript(sessionId, qid, r.text, 1, version); return; }
      // r.ok=true 但空文本 = 候选人没说话/静音,属正常,不必备份;
      // r.ok=false = 转写服务/账号异常(如欠费) -> 备份录音,等恢复后重转,避免回答永久丢失。
      if (!r.ok) await backupAudioForRetry(sessionId, qid, audio, sampleRate, version);
    } catch {
      // 解压或转写抛错:尽量保留音频(已解压的)以便重转
      try { if (audio && audio.length) await backupAudioForRetry(sessionId, qid, audio, sampleRate, version); } catch { /* ignore */ }
    }
  })();
}

/** 转写失败时把这段 PCM 备份到 COS,并在该题记录 audio_key + 采样率,供后台「重转」。未配 COS 则跳过(无从备份)。
 *  key 带答案版本号,使每次录音的备份相互独立;setQuestionAudioKey 带版本校验,候选人已重答则不写回旧引用。 */
async function backupAudioForRetry(sessionId: string, qid: string, audio: Buffer, sampleRate: number, version: number): Promise<void> {
  if (!cosConfigured()) return;
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  const key = `interview-audio/${safe(sessionId)}/${safe(qid)}-v${version}.pcm`;
  const okPut = await cosPutObject(key, audio, "application/octet-stream");
  if (okPut) Interviews.setQuestionAudioKey(sessionId, qid, key, sampleRate, version);
}

function ok(reply: FastifyReply, p: Record<string, unknown> = {}) { return reply.send({ ok: true, ...p }); }

/** 解析候选人邀约 token,过期/不存在直接回错。 */
function resolveOrError(token: string, reply: FastifyReply) {
  const r = Interviews.resolveByInviteToken(token);
  if (!r.found) { reply.code(404).send({ ok: false, error: "link_not_found" }); return null; }
  if (r.expired) { reply.code(410).send({ ok: false, error: "link_expired" }); return null; }
  return r.session;
}

/** 写操作守卫:会话已结束(completed/terminated)、或已超总时长/离开太久 -> 拒绝(并固化为 terminated),
 *  防止候选人在提交后或超时后还能改答案。返回 false 表示已回错、调用方应直接 return。 */
function requireAnswerable(session: any, reply: FastifyReply): boolean {
  if (session.status === "completed" || session.status === "terminated") {
    reply.code(409).send({ ok: false, error: "interview_closed" });
    return false;
  }
  const { gate } = evalGate(session, getInterviewSettings().maxDurationMin);
  if (gate === "locked") {
    Interviews.setSessionStatus(session.id, "terminated");
    reply.code(409).send({ ok: false, error: "interview_closed" });
    return false;
  }
  return true;
}

/** 写守卫(放行乐观提交的"在途末段"):正常会话走 requireAnswerable;
 *  对刚提交(completed)但该题还没答完(status!=='answered')的会话放行 —— 这是乐观提交下末段录音
 *  还在上传途中,必须允许它的 /answer + /complete 写入,否则末题会被 409 静默丢弃。
 *  terminated(超时/手动结束)一律不放行。 */
function answerableOrInflight(session: any, qid: string, reply: FastifyReply): boolean {
  if (session.status !== "completed" && session.status !== "terminated") return requireAnswerable(session, reply);
  if (session.status === "completed") {
    const q = (Array.isArray(session.questions) ? session.questions : []).find((x: any) => x.questionId === qid);
    if (q && q.status !== "answered") return true; // 在途末段,放行
  }
  reply.code(409).send({ ok: false, error: "interview_closed" });
  return false;
}

export function registerAsyncInterviewRoutes(app: FastifyInstance) {
  // (已删除公开的 transcribe-test 接口:它无鉴权/无限流可被刷付费转写;设备检测已改用纯波形,不再需要)

  // ───────── 候选人公开入口 ─────────
  app.get("/api/public/interview/:token", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    // 已完成/已终止的会话,即使邀约链接过了 48h 也允许查看(等待页/结果通知);
    // 只有"还没做完"的链接过期才拦(等待期 3-5 工作日 > 48h,否则候选人看不到结果)。
    const r = Interviews.resolveByInviteToken(token);
    if (!r.found) return reply.code(404).send({ ok: false, error: "link_not_found" });
    if (r.expired && r.session.status !== "completed" && r.session.status !== "terminated") {
      return reply.code(410).send({ ok: false, error: "link_expired" });
    }
    const session = r.session;
    // 给候选人的精简视图:不泄露评判内容
    const safeQuestions = session.questions.map((q: any) => ({
      questionId: q.questionId, ord: q.ord, originalQuestion: q.originalQuestion,
      status: q.status, followUpQuestion: q.followUpQuestion,
      audioReceived: q.audioReceived, answerCompletedAt: q.answerCompletedAt,
    }));
    const brand = getBrand();
    const settings = getInterviewSettings();
    // 一次性闸门:已开始但超总时长/长时间离开 -> locked,并把状态固化为 terminated(本轮结束,
    // 再开链接也进不来,需后台「重新开启」),杜绝来回修正答案。
    const { gate, deadlineAt } = evalGate(session, settings.maxDurationMin);
    if (gate === "locked" && session.status === "in_progress") {
      Interviews.setSessionStatus(session.id, "terminated");
    }
    // 面试官在日历里给该候选人安排的"面试安排"(type=interview)提醒:今天及以后的,只给候选人看时间+标题,不含内部备注/沟通记录
    const todayD = new Date().toISOString().slice(0, 10);
    const reminders = session.candidateId
      ? Calendar.listEvents().filter((e) => e.candidateId === session.candidateId && e.type === "interview" && e.date >= todayD).map((e) => ({ date: e.date, startTime: e.startTime || null, endTime: e.endTime || null, title: e.title }))
      : [];
    return ok(reply, {
      interview: {
        id: session.id, candidateName: session.candidateName, candidateRole: session.candidateRole,
        status: session.status, gate,
        currentQuestionId: session.currentQuestionId, inviteExpiresAt: session.inviteExpiresAt,
        questions: safeQuestions,
        brandName: brand.companyName,
        brandTag: brand.tagline,
        answerLimitSec: settings.answerLimitSec,
        // 须知页用:整场总时长上限(分钟,0=不限)、邀约链接有效期(小时);inviteExpiresAt 是该链接到期时刻
        maxDurationMin: settings.maxDurationMin,
        inviteTtlHours: settings.inviteTtlHours,
        reminders, // 面试官在日历里给本人安排的面试提醒(候选人页展示)
        // 整场截止时刻(已开始且设了总时长上限时);候选人页据此倒计时并到点自动结束
        deadlineAt: deadlineAt || null,
        // 仅 AI 视频制作类岗位开放「作品集」上传(答题后,可上传图片/视频代表作)
        worksUpload: isVideoCreatorRole(session.candidateRole),
        worksMax: config.worksMaxCount,
        decision: session.candidateId ? Candidates.getCandidateResult(session.candidateId) : null,
        // 已提交时间(完成/终止时记的 host_ended_at)——等待页给候选人看"已收到"
        submittedAt: (session.status === "completed" || session.status === "terminated") ? (session.hostEndedAt || undefined) : undefined,
      },
    });
  });

  // 候选人填写手机号(用于接收结果短信通知)
  app.post("/api/public/interview/:token/phone", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const session = resolveOrError(token, reply);
    if (!session) return;
    const phone = String((req.body as any)?.phone || "");
    if (!session.candidateId) return ok(reply, { saved: false });
    const saved = Candidates.setCandidatePhone(session.candidateId, phone);
    if (!saved) return reply.code(400).send({ ok: false, error: "invalid_phone" });
    return ok(reply, { saved: true });
  });

  // 候选人自拍照(确认面试者身份),存入候选人档案
  app.post("/api/public/interview/:token/photo", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const session = resolveOrError(token, reply);
    if (!session) return;
    const body = (req.body || {}) as any;
    if (typeof body.photoBase64 !== "string" || !body.photoBase64.startsWith("data:image/")) {
      return reply.code(400).send({ ok: false, error: "invalid_photo" });
    }
    if (!session.candidateId) return ok(reply, { saved: false });
    const saved = Candidates.setCandidatePhoto(session.candidateId, body.photoBase64);
    return ok(reply, { saved });
  });

  app.post("/api/public/interview/:token/presence", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const session = resolveOrError(token, reply);
    if (!session) return;
    const body = (req.body || {}) as any;
    Interviews.updateCandidatePresence(session.id, String(body.questionId || ""), String(body.stage || ""));
    return ok(reply);
  });

  app.post("/api/public/interview/:token/questions/:qid/start", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const session = resolveOrError(token, reply);
    if (!session) return;
    if (!requireAnswerable(session, reply)) return;
    const qid = decodeURIComponent((req.params as any).qid);
    Interviews.startQuestionAnswer(session.id, qid, new Date().toISOString());
    if (session.status === "ready") Interviews.setSessionStatus(session.id, "in_progress");
    return ok(reply);
  });

  // 候选人提交某题作答(整段)。支持 text 直传,或 audio(base64)由服务端转写。
  // 回执:返回 savedSegments,前端确认后才清本地缓存。
  app.post("/api/public/interview/:token/questions/:qid/answer", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const session = resolveOrError(token, reply);
    if (!session) return;
    const qid = decodeURIComponent((req.params as any).qid);
    if (!answerableOrInflight(session, qid, reply)) return;

    // 即时回执:标记已收到整段录音(重答会覆盖+自增版本),不等转写 —— 候选人秒走
    const version = Interviews.markAnswerReceived(session.id, qid);

    // 取音频:优先二进制(application/octet-stream,可 gzip),回退 JSON base64/text。
    // 关键:解压(gunzip)与转写全部丢后台,**绝不在请求里同步解压**——否则一段长录音的 gunzipSync
    // 会卡住整个事件循环,很多人同时提交时所有请求都被堵住。这里立即回执,候选人秒走。
    const ct = String(req.headers["content-type"] || "");
    if (ct.includes("application/octet-stream") && Buffer.isBuffer(req.body)) {
      const raw = req.body as Buffer;
      const isGzip = String(req.headers["x-audio-encoding"] || "") === "gzip";
      const sr = Number(req.headers["x-sample-rate"]);
      processAudioAnswer(session.id, qid, raw, isGzip, Number.isFinite(sr) && sr > 0 ? sr : 16000, version);
    } else {
      const body = (req.body || {}) as any;
      if (typeof body.text === "string" && body.text) {
        Interviews.setQuestionTranscript(session.id, qid, body.text, 1, version);
      } else if (typeof body.audioBase64 === "string" && body.audioBase64) {
        processAudioAnswer(session.id, qid, Buffer.from(body.audioBase64, "base64"), false, body.sampleRate || 16000, version);
      }
    }
    return ok(reply, { saved: true, savedSegments: 1 });
  });

  // 候选人确认此题、切下一题:只标记 answered + 给下一题(评判搬到结束后的后台收尾,候选人不等待)
  app.post("/api/public/interview/:token/questions/:qid/complete", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const session = resolveOrError(token, reply);
    if (!session) return;
    const qid = decodeURIComponent((req.params as any).qid);
    if (!answerableOrInflight(session, qid, reply)) return;
    Interviews.completeQuestion(session.id, qid);
    const rows = Interviews.listQuestionRows(session.id);
    const idx = rows.findIndex((r) => r.question_id === qid);
    const next = rows.slice(idx + 1).find((r) => r.status !== "answered");
    if (next) Interviews.pushQuestion(session.id, next.question_id);
    return ok(reply, {
      nextQuestionId: next?.question_id ?? null,
      nextQuestion: next ? { questionId: next.question_id, originalQuestion: next.prompt } : null,
      finished: !next,
    });
  });

  // 候选人上传图片/作品(答题中可传多张),存入附件表
  app.post("/api/public/interview/:token/questions/:qid/image", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const session = resolveOrError(token, reply);
    if (!session) return;
    const qid = decodeURIComponent((req.params as any).qid);
    const body = (req.body || {}) as any;
    if (typeof body.imageBase64 !== "string" || !body.imageBase64.startsWith("data:image/")) {
      return reply.code(400).send({ ok: false, error: "invalid_image" });
    }
    // 拒绝 svg/xml 等可执行脚本的"图片"(否则回放时可被当文档触发存储型 XSS)
    if (/^data:image\/(svg|.*xml)/i.test(body.imageBase64)) return reply.code(415).send({ ok: false, error: "unsupported_type" });
    if (body.imageBase64.length > 8_000_000) return reply.code(413).send({ ok: false, error: "image_too_large" });
    Attachments.addAttachment({ interviewId: session.id, questionId: qid, name: typeof body.name === "string" ? body.name.slice(0, 80) : undefined, dataUrl: body.imageBase64 });
    return ok(reply, { count: Attachments.countByInterview(session.id) });
  });

  // ───────── 作品集(kind='portfolio'):图片/视频代表作,落盘,最多 worksMaxCount 个 ─────────
  // 列出本场已上传的作品(元数据 + 回放 url)
  function worksJson(token: string, interviewId: string) {
    return Attachments.listMeta(interviewId)
      .filter((a) => a.kind === "portfolio")
      .map((a) => ({ ...a, url: `/api/public/interview/${token}/works/${a.id}/file` }));
  }

  app.get("/api/public/interview/:token/works", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const session = resolveOrError(token, reply);
    if (!session) return;
    return ok(reply, { works: worksJson(token, session.id), max: config.worksMaxCount });
  });

  // 上传一个作品:二进制(application/octet-stream)+ 头 x-file-mime / x-file-name
  app.post("/api/public/interview/:token/works", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const session = resolveOrError(token, reply);
    if (!session) return;
    // 面试已结束(completed/terminated)后不允许再改作品(防评审期内篡改/替换已提交作品)
    if (session.status === "completed" || session.status === "terminated") return reply.code(409).send({ ok: false, error: "interview_closed" });
    if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ ok: false, error: "binary_required" });
    const buf = req.body as Buffer;
    const mime = String(req.headers["x-file-mime"] || "").toLowerCase().split(";")[0].trim();
    const isVideo = mime.startsWith("video/");
    const isImage = mime.startsWith("image/") && !isDangerousImageMime(mime); // 拒绝 svg/xml/html 等可执行"图片"
    if (!isVideo && !isImage) return reply.code(415).send({ ok: false, error: "unsupported_type" });
    if (Attachments.countByKind(session.id, "portfolio") >= config.worksMaxCount) {
      return reply.code(409).send({ ok: false, error: "max_reached", max: config.worksMaxCount });
    }
    const cap = isVideo ? config.worksVideoMaxBytes : config.worksImageMaxBytes;
    if (buf.length === 0) return reply.code(400).send({ ok: false, error: "empty" });
    if (buf.length > cap) return reply.code(413).send({ ok: false, error: "too_large", max: cap });

    let rawName = "";
    try { rawName = decodeURIComponent(String(req.headers["x-file-name"] || "")); } catch { rawName = String(req.headers["x-file-name"] || ""); }
    const name = rawName.replace(/[\r\n]/g, "").slice(0, 120) || (isVideo ? "视频作品" : "图片作品");

    // 落盘文件名用独立随机串(与 DB 行 id 无需相同;回放按 file_path 取文件)
    const fileName = `pf-${crypto.randomUUID()}${extForMime(mime)}`;
    try {
      mkdirSync(config.uploadsDir, { recursive: true });
      await writeFile(worksPath(fileName), buf); // 异步落盘,避免大视频写盘阻塞事件循环
    } catch { return reply.code(500).send({ ok: false, error: "store_failed" }); }
    const attId = Attachments.addAttachment({
      interviewId: session.id, kind: "portfolio", name, filePath: fileName, mime, size: buf.length,
    });
    return ok(reply, {
      attachment: { id: attId, name, mime, size: buf.length, type: isVideo ? "video" : "image", kind: "portfolio", url: `/api/public/interview/${token}/works/${attId}/file` },
      count: Attachments.countByKind(session.id, "portfolio"),
      max: config.worksMaxCount,
    });
  });

  // 回放作品(图片显示 / 视频拖动)
  app.get("/api/public/interview/:token/works/:attId/file", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const session = resolveOrError(token, reply);
    if (!session) return;
    const attId = decodeURIComponent((req.params as any).attId);
    const att = Attachments.getAttachment(attId);
    if (!att || att.interview_id !== session.id) return reply.code(404).send({ ok: false, error: "not_found" });
    return sendAttachment(req, reply, att);
  });

  // 删除一个作品(候选人自己换掉不满意的)
  app.delete("/api/public/interview/:token/works/:attId", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const session = resolveOrError(token, reply);
    if (!session) return;
    if (session.status === "completed" || session.status === "terminated") return reply.code(409).send({ ok: false, error: "interview_closed" });
    const attId = decodeURIComponent((req.params as any).attId);
    const att = Attachments.getAttachment(attId);
    if (!att || att.interview_id !== session.id || att.kind !== "portfolio") return reply.code(404).send({ ok: false, error: "not_found" });
    if (att.file_path) { try { const p = worksPath(att.file_path); if (existsSync(p)) unlinkSync(p); } catch { /* 文件清不掉不阻塞删行 */ } }
    Attachments.deleteAttachment(attId);
    return ok(reply, { count: Attachments.countByKind(session.id, "portfolio"), max: config.worksMaxCount });
  });

  // 候选人点「结束」:标记完成 + 触发后台收尾(逐题评判 + 报告),候选人立即看到完成页
  app.post("/api/public/interview/:token/finish", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const session = resolveOrError(token, reply);
    if (!session) return;
    // 幂等:已结束的会话不再重复收尾(避免重复触发评判/报告生成)
    if (session.status === "completed" || session.status === "terminated") return ok(reply, { finished: true, already: true });
    Interviews.setSessionStatus(session.id, "completed");
    finalizeInterview(session.id).catch(() => { /* 后台收尾失败可在后台「重新生成报告」 */ });
    return ok(reply, { finished: true });
  });

  // ───────── 后台编排(需登录) ─────────
  // 创建一场异步面试,生成 48h 邀约链接
  app.post("/api/interviews", async (req, reply) => {
    const body = (req.body || {}) as any;
    const questions = Array.isArray(body.questions) ? body.questions : [];
    if (!questions.length) return reply.code(400).send({ ok: false, error: "questions_required" });
    // 先确保候选人存在再建面试(interviews.candidate_id 有 NOT NULL 外键),避免新候选人时外键失败
    if (body.candidateId) {
      try { Candidates.upsertCandidate({ id: body.candidateId, name: body.candidateName || "候选人", role: body.candidateRole, invitationStatus: "invited", currentStage: "interviewing" }); } catch { /* ignore */ }
      // 撤销之前的录用结论(若有),否则候选人打开新链接仍会卡在"已通过/未通过"结论页
      try { Candidates.clearCandidateResult(body.candidateId); } catch { /* ignore */ }
      // 重新发起面试:把该候选人之前未结束的旧面试作废,避免旧链接成孤儿、一直在工作台报"链接将过期"
      try { Interviews.terminateOpenByCandidate(body.candidateId); } catch { /* ignore */ }
    }
    const created = Interviews.createInterview({
      candidateId: body.candidateId, candidateName: body.candidateName, candidateRole: body.candidateRole,
      feishuRecordId: body.feishuRecordId, questions, inviteTtlHours: getInterviewSettings().inviteTtlHours,
    });
    return ok(reply, {
      interviewId: created.id,
      inviteToken: created.inviteToken,
      inviteExpiresAt: created.inviteExpiresAt,
      inviteUrl: `/p/interview/${created.inviteToken}`,
    });
  });

  // 后台对某题重新评判
  app.post("/api/interviews/:id/questions/:qid/judge", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const qid = decodeURIComponent((req.params as any).qid);
    const q = Interviews.getQuestion(id, qid);
    if (!q) return reply.code(404).send({ ok: false, error: "question_not_found" });
    const session = Interviews.getSession(id);
    const judge = await judgeAnswer({ question: q.prompt, dimension: q.dimension || undefined, transcript: q.answer_transcript || "", role: session?.candidateRole });
    Interviews.setQuestionJudgement(id, qid, judge);
    return ok(reply, { judge });
  });

  // 生成/重生成总报告:自动补评判未评的题(即使面试卡在未完成状态也能出报告)+ 生成报告 + 更新阶段
  app.post("/api/interviews/:id/report", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const session = Interviews.getSession(id);
    if (!session) return reply.code(404).send({ ok: false, error: "interview_not_found" });
    await finalizeInterview(id, { wait: false });
    const evaluation = Evaluations.getEvaluationByInterview(id);
    return ok(reply, { evaluation });
  });

  app.get("/api/interviews/:id/report", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    return ok(reply, { evaluation: Evaluations.getEvaluationByInterview(id) });
  });

  // 后台查看候选人附件(作品集 + 答题图片):元数据列表
  app.get("/api/interviews/:id/attachments", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const list = Attachments.listMeta(id).map((a) => ({ ...a, url: `/api/interviews/${id}/attachments/${a.id}/file` }));
    return ok(reply, { attachments: list });
  });

  // 后台:候选人当前实时进度(详情页轮询用)。需管理员登录(全局守卫已拦)
  app.get("/api/candidates/:id/live", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const session = Interviews.getLatestSessionByCandidate(id);
    if (!session) return ok(reply, { live: { hasInterview: false } });
    return ok(reply, { live: deriveLive(session) });
  });

  // 后台:人才库列表用的批量实时进度(只算"面试中"阶段的候选人,人才库每 ~20s 轮询一次)
  app.get("/api/interviews/live", async (_req, reply) => {
    const live: Record<string, any> = {};
    for (const c of Candidates.listCandidates()) {
      if (c.currentStage !== "interviewing") continue;
      const s = Interviews.getLatestSessionByCandidate(c.id);
      if (!s) continue;
      const d = deriveLive(s);
      // 待生成报告:已离线 + 答过题(有录音/转写)+ 还没出评估报告 —— 提示后台一键补生成
      const needsReport = !d.online && d.receivedCount > 0 && !Evaluations.getEvaluationByInterview(s.id);
      live[c.id] = { online: d.online, status: d.status, gate: d.gate, step: d.step, stepLabel: d.stepLabel, answeredCount: d.answeredCount, receivedCount: d.receivedCount, questionTotal: d.questionTotal, lastSeenAt: d.lastSeenAt, deadlineAt: d.deadlineAt, needsReport };
    }
    return ok(reply, { live });
  });

  // 后台:一键为"已答完但还没出报告"的候选人补生成报告(逐题判题+整理+综合报告)。
  // 串行后台跑(避免并发压垮大模型限流),立即返回命中数;前端轮询 live 看 needsReport 减少。
  app.post("/api/interviews/generate-missing-reports", async (_req, reply) => {
    const targets: Array<{ id: string; name: string; sid: string }> = [];
    for (const c of Candidates.listCandidates()) {
      if (c.currentStage !== "interviewing") continue;
      const s = Interviews.getLatestSessionByCandidate(c.id);
      if (!s || s.status === "terminated") continue;
      const d = deriveLive(s);
      if (d.online || d.receivedCount === 0) continue;          // 在线/没答过,跳过
      if (Evaluations.getEvaluationByInterview(s.id)) continue;  // 已有报告,跳过
      targets.push({ id: c.id, name: c.name, sid: s.id });
    }
    (async () => { for (const t of targets) { try { await finalizeInterview(t.sid, { wait: false }); } catch { /* 单个失败不影响其余 */ } } })();
    return ok(reply, { count: targets.length, candidates: targets.map((t) => ({ id: t.id, name: t.name })) });
  });

  // 后台:多人综合对比(简历/回答/综合素质)+ 按当前需求排序 + 推荐理由
  app.post("/api/candidates/compare", async (req, reply) => {
    const body = (req.body || {}) as any;
    const rawIds: string[] = (Array.isArray(body.ids) ? body.ids : []).map((x: any) => String(x));
    const ids: string[] = Array.from(new Set(rawIds)).slice(0, 12);
    const focus = typeof body.focus === "string" ? body.focus.slice(0, 500) : "";
    if (ids.length < 2) return reply.code(400).send({ ok: false, error: "need_at_least_2" });

    const keyToCand: Record<string, { id: string; name: string }> = {};
    const inputs: CompareCandidateInput[] = [];
    let role0: string | undefined;
    ids.forEach((id, i) => {
      const c = Candidates.getCandidate(id) as any;
      if (!c) return;
      if (!role0) role0 = c.role;
      const key = "C" + (i + 1);
      keyToCand[key] = { id, name: c.name };
      const s = Interviews.getLatestSessionByCandidate(id);
      const ev: any = s ? Evaluations.getEvaluationByInterview(s.id) : null;
      const raw: any = ev?.raw || {};
      inputs.push({
        key, name: c.name, role: c.role,
        edu: [c.eduSchoolTier, c.eduDegree, c.eduSchoolName].filter(Boolean).join(" ") || undefined,
        location: [c.locationCurrent ? "现居" + c.locationCurrent : "", c.locationExpect ? "期望" + c.locationExpect : "", c.isLocal ? "徐州本地" : ""].filter(Boolean).join(" / ") || undefined,
        interviewGrade: ev?.grade || c.priority || undefined,
        evalSummary: ev?.summary || undefined,
        answersOverview: raw.answersOverview || undefined,
        strengths: Array.isArray(raw.strengths) ? raw.strengths.map(String) : undefined,
        concerns: Array.isArray(raw.concerns) ? raw.concerns.map(String) : undefined,
        teachingIp: raw.teachingIp || undefined,
        resumeBrief: c.resumeText || undefined,
        hasInterview: !!ev,
      });
    });
    if (inputs.length < 2) return reply.code(400).send({ ok: false, error: "candidates_not_found" });

    const result = await compareCandidates({ candidates: inputs, focus, role: role0 });
    // 对账:按 key 去重(保首条)+ 丢弃模型编造的野 key + 补回模型漏返的候选人(置末)+ 按最终顺序重排 rank=1..n
    const seen = new Set<string>();
    const ordered: Array<{ id: string; name: string; score: number; dims: any; oneLine: string; reason: string }> = [];
    for (const r of result.ranking) {
      const cand = keyToCand[r.key];
      if (!cand || seen.has(r.key)) continue;
      seen.add(r.key);
      ordered.push({ ...cand, score: r.score, dims: r.dims, oneLine: r.oneLine, reason: r.reason });
    }
    for (const key of Object.keys(keyToCand)) {
      if (seen.has(key)) continue;
      ordered.push({ ...keyToCand[key], score: 0, dims: { resume: 0, interview: 0, quality: 0 }, oneLine: "(AI 未对其排序)", reason: "AI 未给出该候选人的对比结论,可重试或人工评估。" });
    }
    const ranking = ordered.map((r, i) => ({ ...r, rank: i + 1 }));
    return ok(reply, { ranking, summary: result.summary });
  });

  // 后台:一键清理超时未响应 —— 已发链接、超过 days 天(默认 2)仍未答任何一题的候选人:
  // 终止旧面试链接 + 候选人状态清零为"已发链接未响应"(不删简历)。已答过题/已提交的不动。
  app.post("/api/candidates/cleanup-stale", async (req, reply) => {
    const days = Math.min(60, Math.max(1, Number((req.body as any)?.days) || 2));
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    const cleared: Array<{ id: string; name: string }> = [];
    for (const c of Candidates.listCandidates()) {
      if (c.currentStage !== "interviewing") continue;
      const s = Interviews.getLatestSessionByCandidate(c.id);
      if (!s) continue;
      if (s.status === "completed") continue; // 已提交,保留
      const d = deriveLive(s);
      if (d.online) continue; // 此刻在线(正在操作),不清
      if (d.answeredCount > 0 || d.receivedCount > 0) continue; // 答过/录过任意一题,不算未响应
      const created = s.createdAt ? new Date(s.createdAt).getTime() : 0;
      const expired = s.inviteExpiresAt ? new Date(s.inviteExpiresAt).getTime() < Date.now() : false;
      if (!(created && created < cutoff) && !expired) continue; // 未超时且链接未过期 -> 不清
      try { Interviews.setSessionStatus(s.id, "terminated"); } catch { /* ignore */ }
      Candidates.markNoResponse(c.id);
      cleared.push({ id: c.id, name: c.name });
    }
    return ok(reply, { count: cleared.length, cleared });
  });

  // 后台回放某个附件(图片/视频);需管理员登录(全局守卫已拦)
  app.get("/api/interviews/:id/attachments/:attId/file", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const attId = decodeURIComponent((req.params as any).attId);
    const att = Attachments.getAttachment(attId);
    if (!att || att.interview_id !== id) return reply.code(404).send({ ok: false, error: "not_found" });
    return sendAttachment(req, reply, att);
  });

  // 品牌(公司名)—— 候选人面试页显示
  app.get("/api/settings/brand", async (_req, reply) => ok(reply, { brand: getBrand() }));
  app.post("/api/settings/brand", async (req, reply) => {
    const body = (req.body || {}) as any;
    const prev = getBrand();
    const companyName = (typeof body.companyName === "string" && body.companyName.trim() ? body.companyName.trim() : prev.companyName).slice(0, 40);
    const tagline = (typeof body.tagline === "string" && body.tagline.trim() ? body.tagline.trim() : prev.tagline).slice(0, 40);
    setSetting("brand", { companyName, tagline });
    return ok(reply, { brand: { companyName, tagline } });
  });

  // 岗位画像 / 评分标准(多岗位 + 加权)
  app.get("/api/settings/job-profile", async (_req, reply) => ok(reply, { config: getConfig() }));
  app.post("/api/settings/job-profile", async (req, reply) => ok(reply, { config: saveConfig((req.body || {}) as any) }));

  // 面试设置:每题回答时长上限(0=不限时)+ 整场总时长上限(分钟,0=不限)
  app.get("/api/settings/interview", async (_req, reply) => ok(reply, { settings: getInterviewSettings() }));
  app.post("/api/settings/interview", async (req, reply) => {
    const body = (req.body || {}) as any;
    const prev = getInterviewSettings();
    const a = Number(body.answerLimitSec);
    const d = Number(body.maxDurationMin);
    const t = Number(body.inviteTtlHours);
    const answerLimitSec = Number.isFinite(a) && a >= 0 ? Math.round(a) : prev.answerLimitSec;
    const maxDurationMin = Number.isFinite(d) && d >= 0 ? Math.round(d) : prev.maxDurationMin;
    const inviteTtlHours = Number.isFinite(t) && t > 0 ? Math.round(t) : prev.inviteTtlHours;
    setSetting("interview_settings", { answerLimitSec, maxDurationMin, inviteTtlHours });
    return ok(reply, { settings: { answerLimitSec, maxDurationMin, inviteTtlHours } });
  });

  // 后台「重新开启面试」:把已结束/超时锁定的同一场面试重置为可重新作答(同一链接、同一批题目),
  // 并续期邀约链接。用于候选人误超时/需要给机会重做时,由面试官手动放行。
  app.post("/api/interviews/:id/reopen", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const session = Interviews.getSession(id);
    if (!session) return reply.code(404).send({ ok: false, error: "interview_not_found" });
    const result = Interviews.reopenInterview(id, getInterviewSettings().inviteTtlHours);
    // 撤销之前的录用结论(若有)+ 阶段拉回"一面中",否则候选人打开链接仍卡在"已通过/未通过"页进不了答题
    if (session.candidateId) {
      try { Candidates.clearCandidateResult(session.candidateId); } catch { /* ignore */ }
      try { Candidates.upsertCandidate({ id: session.candidateId, name: session.candidateName || "候选人", currentStage: "interviewing", invitationStatus: "invited" }); } catch { /* ignore */ }
    }
    return ok(reply, {
      interview: result,
      inviteUrl: result?.candidateLinkToken ? `/p/interview/${result.candidateLinkToken}` : undefined,
      inviteExpiresAt: result?.inviteExpiresAt,
    });
  });

  // 后台「重转失败题」:对转写失败时备份了录音(audio_key)且仍无转写文字的题,从 COS 取回录音重新转写。
  // 用于转写服务恢复后(如阿里账号欠费充值后)一键补回这些题的文字,不必让候选人重答。
  app.post("/api/interviews/:id/retranscribe", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const session = Interviews.getSession(id);
    if (!session) return reply.code(404).send({ ok: false, error: "interview_not_found" });
    const rows = Interviews.listQuestionRows(id).filter((q) => q.audio_key && !(q.raw_transcript || "").trim());
    let done = 0, failed = 0, skipped = 0;
    for (const q of rows) {
      try {
        const audio = await cosGetObject(q.audio_key as string);
        if (!audio || !audio.length) { failed++; continue; }
        const r = await transcribeAudio({ audio, format: "pcm", sampleRate: q.audio_sample_rate || 16000 });
        if (!(r.ok && r.text)) { failed++; continue; } // 仍失败(服务还没恢复):保留备份,下次可再试
        // 写回前重读该题:转写这段时间里若候选人已重答(版本或备份 key 变了),旧录音的转写作废,
        // 跳过 —— 不覆盖新答案、不删新备份(配合带版本号的 key)。
        const cur = Interviews.getQuestionRow(id, q.question_id);
        if (!cur || cur.audio_key !== q.audio_key || cur.answer_version !== q.answer_version) { skipped++; continue; }
        Interviews.setQuestionTranscript(id, q.question_id, r.text, 1, q.answer_version ?? undefined);
        Interviews.clearQuestionAudioKey(id, q.question_id);
        try { await cosDeleteObject(q.audio_key as string); } catch { /* 删备份失败不影响 */ }
        done++;
      } catch { failed++; }
    }
    return ok(reply, { total: rows.length, retranscribed: done, failed, skipped });
  });
}
