// 社招资料收集:给没有简历的社招候选人生成"一问一答"收集链接(主播岗含视频录入+自动截帧)。
// 收集配置复用 booking_links 表(purpose='resume-collection');视频/截帧落盘到 uploadsDir,路径存配置,不进附件表。
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, unlinkSync, createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { nowIso } from "../db.js";
import * as Bookings from "../repo/bookings.js";
import * as Candidates from "../repo/candidates.js";
import { generateCollectionQuestions, buildResumeFromCollection, defaultCollectCategories, BASIC_INFO_FIELDS, evaluateAnchorCollection } from "../services/interview-ai.js";
import { cosConfigured, cosPresignUrl, cosDeleteObject } from "../services/cos.js";
import { transcribeCosVideo } from "../services/video-transcribe.js";

function ok(reply: FastifyReply, p: Record<string, unknown> = {}) { return reply.send({ ok: true, ...p }); }

// 主播岗"形象展示"环节用的虚构带货产品(都是生活常识里的常见物,人人能讲)
const PITCH_PRODUCTS = ["一瓶普通的矿泉水", "一支牙刷", "一个保温杯", "一把雨伞", "一包抽纸", "一个充电宝", "一支圆珠笔", "一块香皂", "一桶泡面", "一双棉袜", "一瓶洗发水", "一个雨衣", "一盒牙膏", "一个搪瓷杯", "一袋瓜子"];
function pickPitchProduct(): string { return PITCH_PRODUCTS[Math.floor(Math.random() * PITCH_PRODUCTS.length)]; }
function mediaPath(file: string): string { mkdirSync(config.uploadsDir, { recursive: true }); return join(config.uploadsDir, file); }
function getCollection(token: string): any {
  const cfg = Bookings.getBookingLink(token) as any;
  return cfg && cfg.purpose === "resume-collection" ? cfg : null;
}

// 把收集到的问答(含视频转写)整理成带类别的 qa
function collectQa(cfg: any): Array<{ q: string; a: string; category?: string }> {
  return (cfg.questions || []).map((q: any) => ({ q: q.q, a: (cfg.answers || {})[q.id] || "", category: q.category }));
}
// 还在等转写的题:有视频回执但答案还空的题
function pendingTranscripts(cfg: any): string[] {
  const qv = cfg.questionVideos || {};
  return Object.keys(qv).filter((qid) => !String((cfg.answers || {})[qid] || "").trim());
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 轮询等待视频题转写写回(最多 tries 次,每次 gapMs)
async function waitTranscripts(token: string, tries: number, gapMs: number): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const cfg = getCollection(token);
    if (!cfg || !pendingTranscripts(cfg).length) return;
    await sleep(gapMs);
  }
}
// 跑主播岗综合评定并写回 cfg.evaluation
async function runAnchorEvaluation(token: string): Promise<any | null> {
  const cfg = getCollection(token);
  if (!cfg || cfg.type !== "anchor") return null;
  const evaluation = await evaluateAnchorCollection({ name: cfg.candidateName, role: cfg.role, basic: cfg.basicInfo || {}, qa: collectQa(cfg) });
  const result = { ...evaluation, generatedAt: nowIso() };
  const fresh = getCollection(token) || cfg;
  Bookings.saveBookingLink(token, { ...fresh, evaluation: result });
  return result;
}

export function registerCollectionRoutes(app: FastifyInstance) {
  // ───────── 管理员 ─────────
  // 某类型的默认问题类别+配比(新建弹窗用)
  app.get("/api/collections/categories", async (req, reply) => {
    const type = (req.query as any)?.type === "anchor" ? "anchor" : "normal";
    return ok(reply, { categories: defaultCollectCategories(type) });
  });

  // 新建社招资料收集:AI 按岗位+类型+类别配比生成归类问题 -> 建候选人(无简历)-> 生成收集链接
  app.post("/api/collections", async (req, reply) => {
    const body = (req.body || {}) as any;
    const name = String(body.name || "").trim();
    if (!name) return reply.code(400).send({ ok: false, error: "name_required" });
    const role = body.role ? String(body.role).trim() : undefined;
    const type: "anchor" | "normal" = body.type === "anchor" ? "anchor" : "normal";
    const counts = Array.isArray(body.counts) ? body.counts.map((c: any) => ({ key: String(c.key || ""), name: String(c.name || ""), n: Math.max(0, Math.min(8, Number(c.n) || 0)) })).filter((c: any) => c.name) : undefined;
    const questions = await generateCollectionQuestions({ role, type, focus: body.focus, counts });
    const candidateId = `collect-${randomUUID().slice(0, 12)}`;
    Candidates.upsertCandidate({
      id: candidateId, name, role, source: "社招", invitationStatus: "collecting", currentStage: "intake",
      resumeText: `【人员姓名】${name}\n\n【岗位方向】${role || ""}\n\n【来源】社招·在线资料收集中(${type === "anchor" ? "主播岗·含视频" : "普通"})`,
    });
    const token = `cl-${randomUUID().slice(0, 12)}`;
    Bookings.saveBookingLink(token, { purpose: "resume-collection", candidateId, candidateName: name, role, type, questions, answers: {}, video: null, frames: [], pitchProduct: type === "anchor" ? pickPitchProduct() : null, status: "open", createdAt: nowIso() });
    return ok(reply, { token, url: `/p/collect/${token}`, candidateId, type, questions });
  });

  // 查某候选人的收集状态(详情页用)
  app.get("/api/collections/by-candidate/:candidateId", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).candidateId);
    const found = Bookings.findCollectionByCandidate(id);
    if (!found) return ok(reply, { collection: null });
    const cfg = found.config;
    return ok(reply, { collection: { token: found.token, url: `/p/collect/${found.token}`, type: cfg.type, status: cfg.status, questions: cfg.questions, answers: cfg.answers, hasVideo: !!cfg.video, videoStore: cfg.videoStore || "local", frames: (cfg.frames || []).length, evaluation: cfg.evaluation || null, pendingTranscripts: pendingTranscripts(cfg).length, answerVideos: Object.keys(cfg.questionVideos || {}) } });
  });

  // 管理员:为主播岗候选人生成/重新生成「综合评定」(从 5 维度打分 + 结论)
  app.post("/api/collections/:token/evaluate", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const cfg = getCollection(token);
    if (!cfg) return reply.code(404).send({ ok: false, error: "not_found" });
    if (cfg.type !== "anchor") return reply.code(400).send({ ok: false, error: "not_anchor" });
    await waitTranscripts(token, 5, 3000); // 给在途转写一点时间(最多 ~15s)
    try {
      const evaluation = await runAnchorEvaluation(token);
      return ok(reply, { evaluation });
    } catch (e) {
      return reply.code(500).send({ ok: false, error: "evaluate_failed", message: (e as Error).message });
    }
  });

  // 编辑收集问题(后台可改)
  app.post("/api/collections/:token/questions", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const cfg = getCollection(token);
    if (!cfg) return reply.code(404).send({ ok: false, error: "not_found" });
    const qs = (((req.body || {}) as any).questions || []).filter((q: any) => q?.q).map((q: any, i: number) => ({ id: q.id || `cq${i + 1}`, q: String(q.q), hint: q.hint ? String(q.hint) : undefined, category: q.category ? String(q.category) : undefined }));
    if (!qs.length) return reply.code(400).send({ ok: false, error: "questions_required" });
    Bookings.saveBookingLink(token, { ...cfg, questions: qs });
    return ok(reply, { questions: qs });
  });

  // 删除主播视频(只删视频文件,保留文字+截帧)
  app.post("/api/collections/:token/delete-video", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const cfg = getCollection(token);
    if (!cfg) return reply.code(404).send({ ok: false, error: "not_found" });
    if (cfg.video) {
      if (cfg.videoStore === "cos") { try { await cosDeleteObject(cfg.video); } catch { /* ignore */ } }
      else { try { const p = mediaPath(cfg.video); if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ } }
    }
    Bookings.saveBookingLink(token, { ...cfg, video: null, videoStore: null });
    return ok(reply, { deleted: true });
  });

  // 管理员回看收集的视频/截帧文件
  app.get("/api/collections/:token/media/:file", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const file = decodeURIComponent((req.params as any).file);
    const cfg = getCollection(token);
    if (!cfg) return reply.code(404).send({ ok: false, error: "not_found" });
    if (file !== cfg.video && !(cfg.frames || []).includes(file)) return reply.code(404).send({ ok: false, error: "not_found" });
    const p = mediaPath(file);
    if (!existsSync(p)) return reply.code(404).send({ ok: false, error: "file_gone" });
    reply.header("Content-Type", file.endsWith(".webm") ? "video/webm" : file.endsWith(".mp4") ? "video/mp4" : "image/jpeg");
    return reply.send(createReadStream(p));
  });

  // ───────── 候选人公开入口 ─────────
  app.get("/api/public/collect/:token", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const cfg = getCollection(token);
    if (!cfg) return reply.code(404).send({ ok: false, error: "not_found" });
    return ok(reply, { candidateName: cfg.candidateName, role: cfg.role, type: cfg.type, questions: cfg.questions, answers: cfg.answers || {}, hasVideo: !!cfg.video, status: cfg.status, cosUpload: cosConfigured(), pitchProduct: cfg.pitchProduct || null, basicFields: BASIC_INFO_FIELDS, basicInfo: cfg.basicInfo || {}, basicDone: !!cfg.basicDone });
  });

  // 候选人:提交基础资料表格(视频/问答前先填)
  app.post("/api/public/collect/:token/basic", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const cfg = getCollection(token);
    if (!cfg) return reply.code(404).send({ ok: false, error: "not_found" });
    if (cfg.status === "done") return reply.code(409).send({ ok: false, error: "closed" });
    const info = ((req.body || {}) as any).info || {};
    const clean: Record<string, string> = {};
    for (const f of BASIC_INFO_FIELDS) { const v = info[f.key]; if (v != null && String(v).trim()) clean[f.key] = String(v).trim().slice(0, 100); }
    Bookings.saveBookingLink(token, { ...cfg, basicInfo: clean, basicDone: true });
    return ok(reply, { saved: true });
  });

  // 主播视频:申请 COS 预签名直传 URL(浏览器直接 PUT 到 COS,绕开隧道)
  app.post("/api/public/collect/:token/video-presign", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const cfg = getCollection(token);
    if (!cfg || cfg.type !== "anchor") return reply.code(404).send({ ok: false, error: "not_found" });
    if (cfg.status === "done") return reply.code(409).send({ ok: false, error: "closed" });
    if (!cosConfigured()) return reply.code(400).send({ ok: false, error: "cos_not_configured" });
    const ext = String(((req.body || {}) as any).ext || "webm").replace(/[^a-z0-9]/gi, "") || "webm";
    const key = `collect/${token}/video.${ext}`;
    const uploadUrl = cosPresignUrl("PUT", key, 3600);
    return ok(reply, { uploadUrl, key });
  });

  // 主播视频:COS 直传完成,把 key 记到收集配置(videoStore=cos)
  app.post("/api/public/collect/:token/video-cos-done", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const cfg = getCollection(token);
    if (!cfg || cfg.type !== "anchor") return reply.code(404).send({ ok: false, error: "not_found" });
    const key = String(((req.body || {}) as any).key || "");
    if (!key.startsWith(`collect/${token}/`)) return reply.code(400).send({ ok: false, error: "bad_key" });
    Bookings.saveBookingLink(token, { ...cfg, video: key, videoStore: "cos" });
    return ok(reply, { saved: true });
  });

  // 管理员:拿视频回看地址(COS 视频返回预签名 GET URL;本地视频走 media 路由)
  app.get("/api/collections/:token/video-url", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const cfg = getCollection(token);
    if (!cfg || !cfg.video) return reply.code(404).send({ ok: false, error: "not_found" });
    if (cfg.videoStore === "cos") return ok(reply, { url: cosPresignUrl("GET", cfg.video, 3600) });
    return ok(reply, { url: `/api/collections/${encodeURIComponent(token)}/media/${encodeURIComponent(cfg.video)}` });
  });

  // 管理员:拿某题视频回答的回看地址(每题视频都是 COS 直传,返回预签名 GET URL)
  app.get("/api/collections/:token/answer-video-url", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const qid = String((req.query as any)?.qid || "");
    const cfg = getCollection(token);
    if (!cfg) return reply.code(404).send({ ok: false, error: "not_found" });
    const key = (cfg.questionVideos || {})[qid];
    if (!key) return reply.code(404).send({ ok: false, error: "no_video" });
    if (!cosConfigured()) return reply.code(400).send({ ok: false, error: "cos_not_configured" });
    return ok(reply, { url: cosPresignUrl("GET", key, 3600) });
  });

  // 管理员:删除某题视频回答(只删该题视频,保留转写文字答案)
  app.post("/api/collections/:token/delete-answer-video", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const cfg = getCollection(token);
    if (!cfg) return reply.code(404).send({ ok: false, error: "not_found" });
    const qid = String(((req.body || {}) as any).qid || "");
    const key = (cfg.questionVideos || {})[qid];
    if (!key) return reply.code(404).send({ ok: false, error: "no_video" });
    try { await cosDeleteObject(key); } catch { /* 远端删失败也清本地引用 */ }
    // cosDeleteObject 是异步往返,期间可能有转写/评定写回;重读最新 cfg 再删该题引用,避免整体覆盖丢更新
    const fresh = getCollection(token) || cfg;
    const qv = { ...(fresh.questionVideos || {}) };
    delete qv[qid];
    Bookings.saveBookingLink(token, { ...fresh, questionVideos: qv });
    return ok(reply, { deleted: true });
  });

  // 主播岗·某题视频回答:申请该题的 COS 预签名直传 URL
  app.post("/api/public/collect/:token/answer-video-presign", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const cfg = getCollection(token);
    if (!cfg || cfg.type !== "anchor") return reply.code(404).send({ ok: false, error: "not_found" });
    if (cfg.status === "done") return reply.code(409).send({ ok: false, error: "closed" });
    if (!cosConfigured()) return reply.code(400).send({ ok: false, error: "cos_not_configured" });
    const qid = String(((req.body || {}) as any).qid || "");
    if (!cfg.questions.some((q: any) => q.id === qid)) return reply.code(400).send({ ok: false, error: "bad_qid" });
    const ext = String(((req.body || {}) as any).ext || "webm").replace(/[^a-z0-9]/gi, "") || "webm";
    const key = `collect/${token}/q-${qid}.${ext}`;
    return ok(reply, { uploadUrl: cosPresignUrl("PUT", key, 3600), key });
  });

  // 主播岗·某题视频回答上传完成:记录该题视频 key + 抽音频转写,转写文字作为该题答案
  app.post("/api/public/collect/:token/answer-video-done", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const cfg = getCollection(token);
    if (!cfg || cfg.type !== "anchor") return reply.code(404).send({ ok: false, error: "not_found" });
    const body = (req.body || {}) as any;
    const qid = String(body.qid || "");
    const key = String(body.key || "");
    if (!cfg.questions.some((q: any) => q.id === qid)) return reply.code(400).send({ ok: false, error: "bad_qid" });
    if (!key.startsWith(`collect/${token}/`)) return reply.code(400).send({ ok: false, error: "bad_key" });
    // 先记录视频 key,立即返回 —— 候选人不必等转写;转写丢后台,完成后写回该题答案
    const fresh = getCollection(token) || cfg;
    const qvideos = { ...(fresh.questionVideos || {}), [qid]: key };
    Bookings.saveBookingLink(token, { ...fresh, questionVideos: qvideos, answers: { ...(fresh.answers || {}), [qid]: (fresh.answers || {})[qid] || "" } });
    (async () => {
      try {
        const t = await transcribeCosVideo(key);
        const c2 = getCollection(token);
        if (c2) Bookings.saveBookingLink(token, { ...c2, answers: { ...(c2.answers || {}), [qid]: t } });
      } catch { /* 转写失败:答案留空,提交时可缺该题;后台可见视频 */ }
    })();
    return ok(reply, { saved: true });
  });

  // 候选人:保存某题回答(随答随存)
  app.post("/api/public/collect/:token/answer", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const cfg = getCollection(token);
    if (!cfg) return reply.code(404).send({ ok: false, error: "not_found" });
    if (cfg.status === "done") return reply.code(409).send({ ok: false, error: "closed" });
    const body = (req.body || {}) as any;
    const qid = String(body.qid || "");
    if (!cfg.questions.some((q: any) => q.id === qid)) return reply.code(400).send({ ok: false, error: "bad_qid" });
    const answers = { ...(cfg.answers || {}), [qid]: String(body.text || "").slice(0, 4000) };
    Bookings.saveBookingLink(token, { ...cfg, answers });
    return ok(reply, { saved: true });
  });

  // 主播:上传视频(octet-stream 二进制)
  app.post("/api/public/collect/:token/video", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const cfg = getCollection(token);
    if (!cfg || cfg.type !== "anchor") return reply.code(404).send({ ok: false, error: "not_found" });
    if (cfg.status === "done") return reply.code(409).send({ ok: false, error: "closed" });
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || !buf.length) return reply.code(400).send({ ok: false, error: "empty" });
    if (buf.length > config.worksVideoMaxBytes) return reply.code(413).send({ ok: false, error: "too_large" });
    const ext = String(req.headers["x-ext"] || "webm").replace(/[^a-z0-9]/gi, "") || "webm";
    const file = `collect-${token}-video.${ext}`;
    try { await writeFile(mediaPath(file), buf); } catch { return reply.code(500).send({ ok: false, error: "write_failed" }); }
    Bookings.saveBookingLink(token, { ...cfg, video: file });
    return ok(reply, { saved: true });
  });

  // 主播:上传自动截帧(base64 JPG);第一帧顺便设为候选人头像
  app.post("/api/public/collect/:token/frame", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const cfg = getCollection(token);
    if (!cfg || cfg.type !== "anchor") return reply.code(404).send({ ok: false, error: "not_found" });
    if (cfg.status === "done") return reply.code(409).send({ ok: false, error: "closed" });
    const data = String(((req.body || {}) as any).imageBase64 || "");
    const m = data.match(/^data:image\/\w+;base64,(.+)$/);
    if (!m) return reply.code(400).send({ ok: false, error: "bad_image" });
    const frames: string[] = cfg.frames || [];
    if (frames.length >= 6) return ok(reply, { saved: false, full: true }); // 最多 6 张
    const file = `collect-${token}-frame-${frames.length + 1}.jpg`;
    try { writeFileSync(mediaPath(file), Buffer.from(m[1], "base64")); } catch { return reply.code(500).send({ ok: false, error: "write_failed" }); }
    if (frames.length === 0 && cfg.candidateId) { try { Candidates.setCandidatePhoto(cfg.candidateId, data); } catch { /* ignore */ } }
    Bookings.saveBookingLink(token, { ...cfg, frames: [...frames, file] });
    return ok(reply, { saved: true });
  });

  // 候选人:提交 -> 把一问一答拼成简历写进候选人,收集关闭
  app.post("/api/public/collect/:token/submit", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const cfg = getCollection(token);
    if (!cfg) return reply.code(404).send({ ok: false, error: "not_found" });
    const qa = (cfg.questions || []).map((q: any) => ({ q: q.q, a: (cfg.answers || {})[q.id] || "" }));
    const resumeText = buildResumeFromCollection({ name: cfg.candidateName, role: cfg.role, type: cfg.type, basic: cfg.basicInfo || {}, qa });
    if (cfg.candidateId) {
      Candidates.upsertCandidate({ id: cfg.candidateId, name: cfg.candidateName, role: cfg.role, source: "社招", invitationStatus: "collected", currentStage: "intake", resumeText });
      // 基础资料里明确填的城市/电话,直接写结构化字段(比从文本解析更准)
      const b = (cfg.basicInfo || {}) as Record<string, string>;
      if (b.currentCity || b.expectCity) { try { Candidates.setCandidateLocation(cfg.candidateId, b.currentCity || "", b.expectCity || ""); } catch { /* ignore */ } }
      if (b.phone) { try { Candidates.setCandidatePhone(cfg.candidateId, b.phone); } catch { /* ignore */ } }
    }
    Bookings.saveBookingLink(token, { ...cfg, status: "done", submittedAt: nowIso() });
    // 主播岗:提交后台自动生成综合评定(先等在途转写,最多 ~60s,再评定);失败可在详情页手动重生成
    if (cfg.type === "anchor") {
      (async () => { try { await waitTranscripts(token, 20, 3000); await runAnchorEvaluation(token); } catch { /* 评定失败:详情页可手动「生成综合评定」 */ } })();
    }
    return ok(reply, { submitted: true });
  });
}
