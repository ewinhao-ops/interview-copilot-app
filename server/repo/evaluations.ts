// 评估报告仓库(总报告 + 二面复核清单)。
import { getDb, fromJson, toJson, nowIso } from "../db.js";

export interface EvaluationInput {
  interviewId?: string;
  candidateId?: string;
  summary?: string;
  recommendation?: string;
  grade?: string;
  score?: string;
  reviewChecklist?: Array<{ point: string; why: string }>;
  raw?: Record<string, unknown>;
}

function rowToJson(r: any) {
  return {
    id: r.id,
    interviewId: r.interview_id || undefined,
    candidateId: r.candidate_id || undefined,
    summary: r.summary || "",
    recommendation: r.recommendation || undefined,
    grade: r.grade || undefined,
    score: r.score || undefined,
    reviewChecklist: fromJson(r.review_checklist, [] as Array<{ point: string; why: string }>),
    raw: fromJson(r.raw, {} as Record<string, unknown>),
    createdAt: r.created_at,
  };
}

export function saveEvaluation(input: EvaluationInput) {
  const db = getDb();
  const now = nowIso();
  // 一场面试一份最新报告:按 interview_id 覆盖
  const id =
    (input.interviewId &&
      (db.prepare("SELECT id FROM evaluations WHERE interview_id = ?").get(input.interviewId) as { id: string } | undefined)?.id) ||
    `eval-${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO evaluations (id, interview_id, candidate_id, summary, recommendation, score, grade, review_checklist, raw, created_at)
     VALUES (@id, @interview_id, @candidate_id, @summary, @recommendation, @score, @grade, @review_checklist, @raw, @created_at)
     ON CONFLICT(id) DO UPDATE SET
       summary=excluded.summary, recommendation=excluded.recommendation, score=excluded.score,
       grade=excluded.grade, review_checklist=excluded.review_checklist, raw=excluded.raw, created_at=excluded.created_at`
  ).run({
    id,
    interview_id: input.interviewId ?? null,
    candidate_id: input.candidateId ?? null,
    summary: input.summary ?? "",
    recommendation: input.recommendation ?? null,
    score: input.score ?? null,
    grade: input.grade ?? null,
    review_checklist: toJson(input.reviewChecklist ?? []),
    raw: toJson(input.raw ?? {}),
    created_at: now,
  });
  return getEvaluation(id);
}

export function getEvaluation(id: string) {
  const r = getDb().prepare("SELECT * FROM evaluations WHERE id = ?").get(id);
  return r ? rowToJson(r) : null;
}

export function getEvaluationByInterview(interviewId: string) {
  const r = getDb().prepare("SELECT * FROM evaluations WHERE interview_id = ?").get(interviewId);
  return r ? rowToJson(r) : null;
}

export function listEvaluations() {
  return (getDb().prepare("SELECT * FROM evaluations ORDER BY created_at DESC").all() as any[]).map(rowToJson);
}
