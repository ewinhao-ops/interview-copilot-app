// 人才主表仓库。对前端输出兼容旧 ResumeRecord 形状。
import { getDb, nowIso } from "../db.js";
import { extractEducation } from "../services/education.js";
import { detectXuzhouLocal, extractLocation } from "../services/location.js";
import { getConfig, getPositionForRole } from "../services/job-profile.js";

export interface CandidateRow {
  id: string;
  feishu_record_id: string | null;
  boss_name: string | null;
  name: string;
  role: string | null;
  resume_text: string;
  resume_path: string | null;
  source: string;
  contact_status: string | null;
  invitation_status: string;
  current_stage: string;
  collected_date: string | null;
  score: number | null;
  priority: string | null;
  photo: string | null;
  photo_taken_at: string | null;
  result: string | null;
  result_note: string | null;
  result_at: string | null;
  phone: string | null;
  edu_school_tier: string | null;
  edu_school_name: string | null;
  edu_degree: string | null;
  edu_postgrad: number | null;
  is_local: number | null;
  location_current: string | null;
  location_expect: string | null;
  starred: number | null;
  created_at: string;
  updated_at: string;
}

export function candidateToJson(row: CandidateRow) {
  return {
    id: row.id,
    feishuRecordId: row.feishu_record_id || undefined,
    bossName: row.boss_name || row.name,
    name: row.name,
    role: row.role || "AI应用工程师",
    resumeText: row.resume_text || "",
    resumePath: row.resume_path || undefined,
    source: row.source,
    contactStatus: row.contact_status || undefined,
    invitationStatus: row.invitation_status,
    currentStage: row.current_stage,
    collectedDate: row.collected_date || undefined,
    score: row.score ?? undefined,
    priority: row.priority || undefined,
    photo: row.photo || undefined,
    photoTakenAt: row.photo_taken_at || undefined,
    result: row.result || undefined,
    resultNote: row.result_note || undefined,
    resultAt: row.result_at || undefined,
    phone: row.phone || undefined,
    eduSchoolTier: (row as any).edu_school_tier || undefined,
    eduSchoolName: (row as any).edu_school_name || undefined,
    eduDegree: (row as any).edu_degree || undefined,
    eduPostgrad: !!(row as any).edu_postgrad,
    isLocal: !!(row as any).is_local,
    locationCurrent: (row as any).location_current || undefined,
    locationExpect: (row as any).location_expect || undefined,
    starred: !!(row as any).starred,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 从简历文本抽取手机号(11 位)。 */
export function extractPhone(text: string): string {
  const m = (text || "").match(/1[3-9]\d{9}/);
  return m ? m[0] : "";
}

/** 候选人在面试页填写的手机号(或后台手填)。 */
export function setCandidatePhone(id: string, phone: string): boolean {
  const p = (phone || "").replace(/\D/g, "").slice(0, 11);
  if (!/^1[3-9]\d{9}$/.test(p)) return false;
  return getDb().prepare("UPDATE candidates SET phone=?, updated_at=? WHERE id=?").run(p, nowIso(), id).changes > 0;
}

/** 后台手改候选人所在地(目前所在城市 / 期望城市);空串表示清空。
 *  同步重算 is_local:简历判定(含上学地/矿大) 或 手改城市命中徐州 —— 取或,避免手改非徐州城市误清掉"上学地本地"。 */
export function setCandidateLocation(id: string, current: string, expect: string): boolean {
  const cur = (current || "").trim().slice(0, 40) || null;
  const exp = (expect || "").trim().slice(0, 40) || null;
  const row = getDb().prepare("SELECT resume_text FROM candidates WHERE id=?").get(id) as { resume_text?: string } | undefined;
  const local = (detectXuzhouLocal(row?.resume_text || "") || /徐州/.test(cur || "") || /徐州/.test(exp || "")) ? 1 : 0;
  return getDb()
    .prepare("UPDATE candidates SET location_current=?, location_expect=?, is_local=?, updated_at=? WHERE id=?")
    .run(cur, exp, local, nowIso(), id).changes > 0;
}

/** 后台收藏/取消收藏(星标重点候选人)。 */
export function setCandidateStarred(id: string, starred: boolean): boolean {
  return getDb().prepare("UPDATE candidates SET starred=?, updated_at=? WHERE id=?").run(starred ? 1 : 0, nowIso(), id).changes > 0;
}

/** 一键清理:把"已发链接但超时未响应"的候选人状态清零(不删简历)——
 *  阶段回到"已初筛",邀约状态标记 no_response,旧面试链接由调用方一并终止。 */
export function markNoResponse(id: string): boolean {
  return getDb()
    .prepare("UPDATE candidates SET invitation_status='no_response', current_stage='screened', updated_at=? WHERE id=?")
    .run(nowIso(), id).changes > 0;
}

/** 二面流程的细分阶段(在"待决定"与"已出结果"之间):约二面中 → 二面待确认 → 二面已确认。 */
export const SECOND_INTERVIEW_STAGES = ["second_invited", "second_picked", "second_confirmed"] as const;

/** 是否已进入二面或更后阶段(已出结果 / 二面任一阶段)。
 *  用于:重生成一面报告等场景不要把已进入二面/已下结论的人拖回"待决定"。 */
export function isPostReview(stage?: string | null): boolean {
  return stage === "result" || (SECOND_INTERVIEW_STAGES as readonly string[]).includes(stage || "");
}

/** 设置录用结果(通过/不通过)+ 给候选人的说明,阶段推进到 result。 */
export function setCandidateResult(id: string, result: "pass" | "reject" | null, note: string): boolean {
  const now = nowIso();
  const r = getDb()
    .prepare("UPDATE candidates SET result = ?, result_note = ?, result_at = ?, current_stage = 'result', updated_at = ? WHERE id = ?")
    .run(result, note, now, now, id);
  return r.changes > 0;
}

/** 清除录用结果(撤销通过/不通过)。用于「重新开启/重新发起面试」让候选人能重新作答——
 *  否则候选人公开页因 result 仍在,会一直显示"已通过/未通过"结论页,进不了答题。不改 current_stage。 */
export function clearCandidateResult(id: string): boolean {
  return getDb()
    .prepare("UPDATE candidates SET result = NULL, result_note = '', result_at = NULL, updated_at = ? WHERE id = ?")
    .run(nowIso(), id).changes > 0;
}

/** 轻量取结果(候选人公开页用,避免拉照片/简历)。 */
export function getCandidateResult(id: string): { result: "pass" | "reject" | null; note: string; at: string } | null {
  const r = getDb().prepare("SELECT result, result_note, result_at FROM candidates WHERE id = ?").get(id) as any;
  if (!r) return null;
  return { result: (r.result as any) || null, note: r.result_note || "", at: r.result_at || "" };
}

export function setCandidatePhoto(id: string, dataUrl: string): boolean {
  const r = getDb()
    .prepare("UPDATE candidates SET photo = ?, photo_taken_at = ?, updated_at = ? WHERE id = ?")
    .run(dataUrl, nowIso(), nowIso(), id);
  return r.changes > 0;
}

/** 列表用:去掉沉重的 resume_text 和 photo(base64,单张可达几十~上百 KB),只留列表要显示的字段,大幅减小载荷。 */
export function listCandidates() {
  const rows = getDb()
    .prepare(
      `SELECT id, feishu_record_id, boss_name, name, role, source,
              contact_status, invitation_status, current_stage, collected_date,
              score, priority, result, photo_taken_at, created_at, updated_at,
              edu_school_tier, edu_school_name, edu_degree, edu_postgrad, is_local,
              location_current, location_expect, starred,
              (photo IS NOT NULL AND photo != '') AS has_photo,
              (SELECT rating FROM screenings s WHERE s.candidate_id = candidates.id ORDER BY created_at DESC LIMIT 1) AS screening_rating
       FROM candidates ORDER BY updated_at DESC`
    )
    .all() as any[];
  const cfg = getConfig(); // 一次性加载岗位配置,避免逐行重复读
  return rows.map((r) => {
    const pos = getPositionForRole(r.role, cfg);
    return {
    id: r.id, feishuRecordId: r.feishu_record_id || undefined, bossName: r.boss_name || r.name, name: r.name,
    role: r.role || "AI应用工程师", positionId: pos.id, positionRole: pos.role, source: r.source, contactStatus: r.contact_status || undefined,
    invitationStatus: r.invitation_status, currentStage: r.current_stage, collectedDate: r.collected_date || undefined,
    score: r.score ?? undefined, priority: r.priority || undefined, hasPhoto: !!r.has_photo,
    result: r.result || undefined, screeningRating: r.screening_rating || undefined,
    eduSchoolTier: r.edu_school_tier || undefined, eduSchoolName: r.edu_school_name || undefined,
    eduDegree: r.edu_degree || undefined, eduPostgrad: !!r.edu_postgrad, isLocal: !!r.is_local,
    locationCurrent: r.location_current || undefined, locationExpect: r.location_expect || undefined,
    starred: !!r.starred,
    photoTakenAt: r.photo_taken_at || undefined, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  });
}

/** 彻底删除候选人及其全部关联(面试/题目/附件行/评估/初筛),返回需在磁盘上清掉的作品文件路径。
 *  注意:interviews.candidate_id 是 ON DELETE SET NULL(删候选人不会连带删面试),故这里显式删面试。 */
export function deleteCandidate(id: string): { filePaths: string[] } {
  const db = getDb();
  const ivIds = (db.prepare("SELECT id FROM interviews WHERE candidate_id = ?").all(id) as any[]).map((r) => r.id);
  let filePaths: string[] = [];
  if (ivIds.length) {
    const ph = ivIds.map(() => "?").join(",");
    filePaths = (db.prepare(`SELECT file_path FROM interview_attachments WHERE interview_id IN (${ph}) AND file_path IS NOT NULL`).all(...ivIds) as any[]).map((r) => r.file_path);
  }
  const tx = db.transaction(() => {
    for (const iv of ivIds) db.prepare("DELETE FROM interviews WHERE id = ?").run(iv); // 级联删题目/附件行/评估
    db.prepare("DELETE FROM candidates WHERE id = ?").run(id); // 级联删初筛
  });
  tx();
  return { filePaths };
}

/** 精简版单条(不含 resume_text/photo)—— 工作台等聚合处嵌入用,避免把照片/简历重复塞进列表。 */
export function getCandidateLite(id: string) {
  const r = getDb()
    .prepare("SELECT id, boss_name, name, role, source, current_stage, collected_date, score, priority, result, result_at, created_at, updated_at FROM candidates WHERE id = ?")
    .get(id) as any;
  if (!r) return null;
  return {
    id: r.id, bossName: r.boss_name || r.name, name: r.name, role: r.role || "AI应用工程师", source: r.source,
    currentStage: r.current_stage, collectedDate: r.collected_date || undefined, score: r.score ?? undefined,
    priority: r.priority || undefined, result: r.result || undefined, resultAt: r.result_at || undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function getCandidate(id: string) {
  const row = getDb().prepare("SELECT * FROM candidates WHERE id = ?").get(id) as CandidateRow | undefined;
  return row ? candidateToJson(row) : null;
}

export function findByFeishuRecordId(recordId: string): CandidateRow | undefined {
  return getDb().prepare("SELECT * FROM candidates WHERE feishu_record_id = ?").get(recordId) as CandidateRow | undefined;
}

export function findByName(name: string): CandidateRow | undefined {
  return getDb().prepare("SELECT * FROM candidates WHERE name = ? OR boss_name = ?").get(name, name) as CandidateRow | undefined;
}

export interface CandidateInput {
  id?: string;
  feishuRecordId?: string;
  bossName?: string;
  name: string;
  role?: string;
  resumeText?: string;
  resumePath?: string;
  source?: string;
  contactStatus?: string;
  invitationStatus?: string;
  currentStage?: string;
  collectedDate?: string;
  score?: number;
  priority?: string;
  locationCurrent?: string;
  locationExpect?: string;
}

/** 按 id / feishuRecordId / 姓名 去重的 upsert。返回最终 id。 */
export function upsertCandidate(input: CandidateInput): string {
  const db = getDb();
  const now = nowIso();
  const existing =
    (input.id && (db.prepare("SELECT * FROM candidates WHERE id = ?").get(input.id) as CandidateRow | undefined)) ||
    (input.feishuRecordId && findByFeishuRecordId(input.feishuRecordId)) ||
    (input.name && findByName(input.name)) ||
    undefined;

  const id = existing?.id || input.id || (input.feishuRecordId ? `feishu-${input.feishuRecordId}` : `cand-${crypto.randomUUID()}`);

  // 学历 / 徐州本地 标注按"最终生效的简历文本"重算(新简历非空用新的,否则沿用旧的)
  const effectiveResume = (input.resumeText && input.resumeText.trim()) ? input.resumeText : (existing?.resume_text || "");
  const edu = extractEducation(effectiveResume);
  const isLocal = detectXuzhouLocal(effectiveResume) ? 1 : 0;
  const loc = extractLocation(effectiveResume); // 解析现居/期望城市;显式传入优先,否则用解析值

  db.prepare(
    `INSERT INTO candidates (
       id, feishu_record_id, boss_name, name, role, resume_text, resume_path, source,
       contact_status, invitation_status, current_stage, collected_date, score, priority,
       edu_school_tier, edu_school_name, edu_degree, edu_postgrad, is_local, location_current, location_expect, phone, created_at, updated_at
     ) VALUES (
       @id, @feishu_record_id, @boss_name, @name, @role, @resume_text, @resume_path, @source,
       @contact_status, @invitation_status, @current_stage, @collected_date, @score, @priority,
       @edu_school_tier, @edu_school_name, @edu_degree, @edu_postgrad, @is_local, @location_current, @location_expect, @phone, @created_at, @updated_at
     )
     ON CONFLICT(id) DO UPDATE SET
       feishu_record_id=COALESCE(excluded.feishu_record_id, candidates.feishu_record_id),
       boss_name=excluded.boss_name, name=excluded.name, role=excluded.role,
       resume_text=CASE WHEN excluded.resume_text != '' THEN excluded.resume_text ELSE candidates.resume_text END,
       resume_path=COALESCE(excluded.resume_path, candidates.resume_path),
       source=excluded.source,
       contact_status=COALESCE(excluded.contact_status, candidates.contact_status),
       invitation_status=excluded.invitation_status,
       current_stage=excluded.current_stage,
       collected_date=COALESCE(excluded.collected_date, candidates.collected_date),
       score=COALESCE(excluded.score, candidates.score),
       priority=COALESCE(excluded.priority, candidates.priority),
       edu_school_tier=excluded.edu_school_tier, edu_school_name=excluded.edu_school_name,
       edu_degree=excluded.edu_degree, edu_postgrad=excluded.edu_postgrad, is_local=excluded.is_local,
       location_current=CASE WHEN NULLIF(@location_current_explicit,'') IS NOT NULL THEN @location_current_explicit
                             ELSE COALESCE(NULLIF(candidates.location_current,''), NULLIF(excluded.location_current,'')) END,
       location_expect=CASE WHEN NULLIF(@location_expect_explicit,'') IS NOT NULL THEN @location_expect_explicit
                            ELSE COALESCE(NULLIF(candidates.location_expect,''), NULLIF(excluded.location_expect,'')) END,
       phone=COALESCE(excluded.phone, candidates.phone),
       updated_at=excluded.updated_at`
  ).run({
    id,
    feishu_record_id: input.feishuRecordId ?? existing?.feishu_record_id ?? null,
    boss_name: input.bossName ?? existing?.boss_name ?? input.name,
    name: input.name,
    role: input.role ?? existing?.role ?? "AI应用工程师",
    resume_text: input.resumeText ?? "",
    resume_path: input.resumePath ?? existing?.resume_path ?? null,
    source: input.source ?? existing?.source ?? "manual",
    contact_status: input.contactStatus ?? existing?.contact_status ?? null,
    invitation_status: input.invitationStatus ?? existing?.invitation_status ?? "uninvited",
    current_stage: input.currentStage ?? existing?.current_stage ?? "intake",
    collected_date: input.collectedDate ?? existing?.collected_date ?? now.slice(0, 10),
    score: input.score ?? existing?.score ?? null,
    priority: input.priority ?? existing?.priority ?? null,
    edu_school_tier: edu.schoolTier || null,
    edu_school_name: edu.schoolName || null,
    edu_degree: edu.degree || null,
    edu_postgrad: edu.postgrad ? 1 : 0,
    is_local: isLocal,
    // 显式传入(飞书/BOSS 带城市)用 explicit 走覆盖;否则解析兜底只补空。空串归一为"无显式"。
    location_current_explicit: (input.locationCurrent && input.locationCurrent.trim()) ? input.locationCurrent.trim() : null,
    location_expect_explicit: (input.locationExpect && input.locationExpect.trim()) ? input.locationExpect.trim() : null,
    location_current: (input.locationCurrent && input.locationCurrent.trim()) ? input.locationCurrent.trim() : (loc.current || null),
    location_expect: (input.locationExpect && input.locationExpect.trim()) ? input.locationExpect.trim() : (loc.expect || null),
    phone: (input as any).phone ?? existing?.phone ?? (extractPhone(effectiveResume) || null),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });
  return id;
}

/** 回填:给所有学历标注还是 NULL 的候选人,按现有简历算一遍(部署后跑一次)。 */
export function backfillEducation(): number {
  const db = getDb();
  const rows = db.prepare("SELECT id, resume_text FROM candidates WHERE edu_school_tier IS NULL AND edu_degree IS NULL").all() as Array<{ id: string; resume_text: string }>;
  const upd = db.prepare("UPDATE candidates SET edu_school_tier=?, edu_school_name=?, edu_degree=?, edu_postgrad=? WHERE id=?");
  const tx = db.transaction(() => {
    for (const r of rows) {
      const e = extractEducation(r.resume_text || "");
      upd.run(e.schoolTier || null, e.schoolName || null, e.degree || null, e.postgrad ? 1 : 0, r.id);
    }
  });
  tx();
  return rows.length;
}

/** 回填:给所有候选人按现有简历算一遍"徐州本地"与"现居/期望城市"(部署后跑一次)。
 *  城市用 COALESCE(NULLIF(...)) 写入,只在解析出非空时填,不覆盖后台已手改的值。 */
export function backfillLocal(): number {
  const db = getDb();
  const rows = db.prepare("SELECT id, resume_text FROM candidates").all() as Array<{ id: string; resume_text: string }>;
  const upd = db.prepare(
    "UPDATE candidates SET is_local=?, location_current=COALESCE(NULLIF(location_current,''), ?), location_expect=COALESCE(NULLIF(location_expect,''), ?) WHERE id=?"
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      const loc = extractLocation(r.resume_text || "");
      upd.run(detectXuzhouLocal(r.resume_text || "") ? 1 : 0, loc.current || null, loc.expect || null, r.id);
    }
  });
  tx();
  return rows.length;
}
