// 初筛结果仓库。
import { getDb, fromJson, toJson, nowIso } from "../db.js";
import type { ScreeningResult } from "../services/screening.js";

function rowToJson(r: any) {
  return {
    id: r.id,
    candidateId: r.candidate_id,
    jobProfileId: r.job_profile_id || undefined,
    rating: r.rating,
    summary: r.summary || "",
    reasons: fromJson(r.reasons, [] as Array<{ point: string; quote: string }>),
    risks: fromJson(r.risks, [] as string[]),
    generatedQuestions: fromJson(r.generated_questions, [] as Array<{ questionId: string; dimension: string; question: string }>),
    model: r.model || undefined,
    createdAt: r.created_at,
  };
}

export function saveScreening(candidateId: string, result: ScreeningResult, model?: string) {
  const db = getDb();
  const now = nowIso();
  // 一个候选人保留最新一份初筛
  const id =
    (db.prepare("SELECT id FROM screenings WHERE candidate_id = ?").get(candidateId) as { id: string } | undefined)?.id ||
    `scr-${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO screenings (id, candidate_id, job_profile_id, rating, summary, reasons, risks, generated_questions, model, created_at)
     VALUES (@id, @candidate_id, @job_profile_id, @rating, @summary, @reasons, @risks, @generated_questions, @model, @created_at)
     ON CONFLICT(id) DO UPDATE SET
       rating=excluded.rating, summary=excluded.summary, reasons=excluded.reasons, risks=excluded.risks,
       generated_questions=excluded.generated_questions, model=excluded.model, created_at=excluded.created_at`
  ).run({
    id, candidate_id: candidateId, job_profile_id: result.positionId || "default",
    rating: result.rating, summary: result.summary ?? "", reasons: toJson(result.reasons), risks: toJson(result.risks),
    generated_questions: toJson(result.generatedQuestions), model: model ?? null, created_at: now,
  });
  return getScreeningByCandidate(candidateId);
}

export function getScreeningByCandidate(candidateId: string) {
  const r = getDb().prepare("SELECT * FROM screenings WHERE candidate_id = ?").get(candidateId);
  return r ? rowToJson(r) : null;
}

export function listScreeningsSince(sinceIso: string) {
  return (getDb().prepare("SELECT * FROM screenings WHERE created_at >= ? ORDER BY created_at DESC").all(sinceIso) as any[]).map(rowToJson);
}
