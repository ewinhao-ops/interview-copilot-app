// 初筛 + 今日工作台路由(均需管理员登录)。
import type { FastifyInstance, FastifyReply } from "fastify";
import * as Candidates from "../repo/candidates.js";
import * as Screenings from "../repo/screenings.js";
import { screenCandidate, generateInterviewQuestions, suggestQuestionCounts } from "../services/screening.js";
import { getPositionForRole } from "../services/job-profile.js";
import { regenerateQuestion } from "../services/interview-ai.js";
import { runDailyScreening, getWorkbench } from "../services/daily-screening.js";
import { readAiConfig } from "../ai.js";

function ok(reply: FastifyReply, p: Record<string, unknown> = {}) { return reply.send({ ok: true, ...p }); }

export function registerScreeningRoutes(app: FastifyInstance) {
  // 单个候选人初筛(立即)
  app.post("/api/candidates/:id/screen", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const c = Candidates.getCandidate(id);
    if (!c) return reply.code(404).send({ ok: false, error: "candidate_not_found" });
    const result = await screenCandidate({ name: c.name, role: c.role, resumeText: c.resumeText });
    const saved = Screenings.saveScreening(id, result, readAiConfig().sceneProviders.screening);
    if (c.currentStage === "intake") Candidates.upsertCandidate({ id, name: c.name, currentStage: "screened" });
    return ok(reply, { screening: saved });
  });

  app.get("/api/candidates/:id/screening", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    return ok(reply, { screening: Screenings.getScreeningByCandidate(id) });
  });

  // 按提示词重生成单道面试题(用候选人简历)
  app.post("/api/candidates/:id/regenerate-question", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const c = Candidates.getCandidate(id);
    if (!c) return reply.code(404).send({ ok: false, error: "candidate_not_found" });
    const body = (req.body || {}) as any;
    if (!body.steer) return reply.code(400).send({ ok: false, error: "steer_required" });
    const r = await regenerateQuestion({
      resumeText: c.resumeText, role: c.role, dimension: body.dimension,
      currentQuestion: body.currentQuestion, steer: String(body.steer),
    });
    return ok(reply, { question: r.question });
  });

  // 发起面试弹窗:返回该候选人匹配到的岗位维度 + 按权重的建议配额(供出题表单初始化)
  app.get("/api/candidates/:id/question-plan", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const c = Candidates.getCandidate(id);
    if (!c) return reply.code(404).send({ ok: false, error: "candidate_not_found" });
    const position = getPositionForRole(c.role);
    const defaultTotal = 6;
    return ok(reply, {
      role: c.role || "",
      positionId: position.id,
      positionRole: position.role,
      dimensions: position.dimensions.map((d) => ({ key: d.key, name: d.name, weight: d.weight || 0 })),
      suggested: { total: defaultTotal, counts: suggestQuestionCounts(position, defaultTotal) },
    });
  });

  // 发起面试弹窗:按配额(各维度题数)结合简历定制出题
  app.post("/api/candidates/:id/generate-questions", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const c = Candidates.getCandidate(id);
    if (!c) return reply.code(404).send({ ok: false, error: "candidate_not_found" });
    const body = (req.body || {}) as any;
    const spec = Array.isArray(body.counts)
      ? body.counts.map((x: any) => ({ dimension: String(x?.dimension ?? x?.name ?? ""), count: Math.max(0, Math.round(Number(x?.n ?? x?.count ?? 0))) }))
      : [];
    if (!spec.some((s: any) => s.count > 0)) return reply.code(400).send({ ok: false, error: "counts_required" });
    const questions = await generateInterviewQuestions({ name: c.name, role: c.role, resumeText: c.resumeText, spec });
    if (!questions.length) return reply.code(422).send({ ok: false, error: "generation_failed" });
    return ok(reply, { questions });
  });

  // 批量跑初筛(手动触发"今日初筛")
  app.post("/api/screenings/run", async (req, reply) => {
    const body = (req.body || {}) as any;
    const summary = await runDailyScreening({ limit: body.limit });
    return ok(reply, summary);
  });

  // 今日工作台
  app.get("/api/today", async (_req, reply) => ok(reply, { workbench: getWorkbench() }));
}
