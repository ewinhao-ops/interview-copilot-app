// 每日 AI 初筛批处理 + 今日工作台聚合。
import { getDb } from "../db.js";
import * as Candidates from "../repo/candidates.js";
import * as Screenings from "../repo/screenings.js";
import * as Evaluations from "../repo/evaluations.js";
import * as Bookings from "../repo/bookings.js";
import { screenCandidate } from "./screening.js";
import { readAiConfig } from "../ai.js";

/** 对所有还在 intake(未初筛)的候选人跑一遍初筛,推进到 screened。 */
export async function runDailyScreening(opts: { limit?: number } = {}) {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, name, role, resume_text FROM candidates WHERE current_stage = 'intake' ORDER BY created_at ASC LIMIT ?")
    .all(opts.limit ?? 50) as Array<{ id: string; name: string; role: string | null; resume_text: string }>;

  const model = readAiConfig().sceneProviders.screening;
  const results: Array<{ candidateId: string; name: string; rating: string }> = [];
  for (const c of rows) {
    try {
      const result = await screenCandidate({ name: c.name, role: c.role || undefined, resumeText: c.resume_text || "" });
      Screenings.saveScreening(c.id, result, model);
      Candidates.upsertCandidate({ id: c.id, name: c.name, currentStage: "screened" });
      results.push({ candidateId: c.id, name: c.name, rating: result.rating });
    } catch (e) {
      // 单个失败不阻断批处理
      results.push({ candidateId: c.id, name: c.name, rating: `失败:${(e as Error).message.slice(0, 40)}` });
    }
  }
  return { screened: results.length, results };
}

/** 今日工作台:把"我今天要处理什么"聚成几桶。 */
export function getWorkbench() {
  const db = getDb();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const sinceIso = todayStart.toISOString();
  const now = Date.now();

  // 用 UTC 当天日期,和 screening.createdAt(UTC ISO)的日期部分对齐;sinceIso 用于"今日初筛"过滤另算
  const todayStr = new Date(now).toISOString().slice(0, 10);
  // 今日新初筛(供 allRecentScreenings)
  const recentScreenings = Screenings.listScreeningsSince(sinceIso).map((s) => ({
    id: s.id, candidateId: s.candidateId, rating: s.rating, summary: s.summary,
    generatedQuestionCount: s.generatedQuestions?.length || 0,
    candidate: Candidates.getCandidateLite(s.candidateId),
  }));
  // AI 推荐 · 待发起面试:最近 30 天初筛评级"推荐"、**还没发起面试(stage=screened)**的人,带初筛日期;
  // 前端可按 今天/近7天/全部 筛 + 查看更多,这样也能翻看之前几天的推荐。每人只有一条初筛(saveScreening 是 upsert)。
  const since30 = new Date(now - 30 * 86400000).toISOString();
  const recommendedToInterview = Screenings.listScreeningsSince(since30)
    .map((s) => ({
      id: s.id, candidateId: s.candidateId, rating: s.rating, summary: s.summary,
      generatedQuestionCount: s.generatedQuestions?.length || 0,
      candidate: Candidates.getCandidateLite(s.candidateId),
      screenedAt: (s.createdAt || "").slice(0, 10),
    }))
    .filter((s) => s.rating === "推荐" && s.candidate && s.candidate.currentStage === "screened");

  // 报告已出的候选人 —— ① 按候选人去重(留最新一条评估,避免重新发起面试后同一人重复出现);
  // ② 含"待你决定"(stage=reviewed)+ "最近 7 天已决定"(已点通过/不通过)的,后者带状态保留显示,
  //    方便你知道点过的人去哪了。评估只下发结论(不含 raw/复核清单全文)。
  const recentResultCut = new Date(now - 7 * 86400000).toISOString();
  const reportsReady = (() => {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const e of Evaluations.listEvaluations()) { // created_at DESC,最新在前
      if (!e.candidateId || seen.has(e.candidateId)) continue;
      const candidate = Candidates.getCandidateLite(e.candidateId);
      if (!candidate) continue;
      const pending = candidate.currentStage === "reviewed";
      const decided = candidate.result === "pass" || candidate.result === "reject" ? candidate.result : null;
      const decidedRecent = decided && candidate.resultAt && candidate.resultAt >= recentResultCut;
      if (!pending && !decidedRecent) continue;
      seen.add(e.candidateId);
      out.push({ evaluation: { id: e.id, recommendation: e.recommendation, summary: e.summary, grade: e.grade }, candidate, decided });
    }
    out.sort((a, b) => (a.decided ? 1 : 0) - (b.decided ? 1 : 0)); // 待决定排前,已决定排后
    return out;
  })();

  const allBookings = Bookings.listBookings();
  // 待确认的二面预约(候选人挑了时间、等你确认)
  const pendingBookings = allBookings.filter((b: any) => (b.reviewStatus ?? "pending") === "pending");
  // 已确认、即将进行的二面(今天及以后),用于提醒别错过(复用上面的 todayStr)
  const upcomingInterviews = allBookings
    .filter((b: any) => b.reviewStatus === "approved" && b.slot?.date && String(b.slot.date) >= todayStr)
    .sort((a: any, b: any) => `${a.slot.date}${a.slot.start || ""}`.localeCompare(`${b.slot.date}${b.slot.start || ""}`));

  // 邀约链接:进行中但即将/已过期、且未完成的面试
  // 只提醒"还没下结论"的:已完成/已终止的面试不算,已经标了通过/不通过(result 或 stage=result)的候选人也不再提醒
  const interviews = db
    .prepare(
      `SELECT i.id, i.candidate_id, i.candidate_name, i.invite_token, i.invite_expires_at, i.status
       FROM interviews i LEFT JOIN candidates c ON c.id = i.candidate_id
       WHERE i.invite_token IS NOT NULL AND i.status = 'ready'
         AND (c.id IS NULL OR (c.result IS NULL AND c.current_stage NOT IN ('result','second_invited','second_picked','second_confirmed')))`
    )
    .all() as Array<{ id: string; candidate_id: string | null; candidate_name: string | null; invite_token: string; invite_expires_at: string | null; status: string }>;
  const expiringInvites = interviews
    .filter((i) => i.invite_expires_at)
    .map((i) => ({ ...i, candidateId: i.candidate_id || undefined, expired: new Date(i.invite_expires_at!).getTime() < now, hoursLeft: Math.round((new Date(i.invite_expires_at!).getTime() - now) / 3600000) }))
    .filter((i) => i.expired || i.hoursLeft <= 12);

  return {
    recommendedToInterview,
    todayStr,
    allRecentScreenings: recentScreenings,
    reportsReady,
    pendingBookings,
    upcomingInterviews,
    expiringInvites,
    counts: {
      recommended: recommendedToInterview.filter((s) => s.screenedAt === todayStr).length, // 数字卡只数"今天"的待发起推荐
      reportsReady: reportsReady.filter((x) => !x.decided).length, // 只数"待你决定"的

      pendingBookings: pendingBookings.length,
      upcomingInterviews: upcomingInterviews.length,
      expiringInvites: expiringInvites.length,
    },
  };
}
