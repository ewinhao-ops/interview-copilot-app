// 面试会话仓库:DB(interviews + interview_questions) <-> 前端 InterviewSession 形状。
// 字段名与旧 localStorage/接口保持一致,避免改动前端 9000 行 fetch。
import { getDb, fromJson, toJson, nowIso } from "../db.js";

export interface SessionRow {
  id: string;
  candidate_id: string | null;
  candidate_name: string | null;
  candidate_role: string | null;
  feishu_record_id: string | null;
  invite_token: string | null;
  invite_expires_at: string | null;
  room_token: string | null;
  booking_id: string | null;
  booking_token: string | null;
  booking_room_token: string | null;
  status: string;
  current_question_id: string | null;
  host_started_at: string | null;
  host_ended_at: string | null;
  candidate_entered_at: string | null;
  candidate_last_seen_at: string | null;
  candidate_viewing_question_id: string | null;
  candidate_stage: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuestionRow {
  id: string;
  interview_id: string;
  question_id: string;
  ord: number;
  stage: string | null;
  category: string | null;
  dimension: string | null;
  signal: string | null;
  prompt: string;
  status: string;
  raw_transcript: string;
  answer_transcript: string;
  transcript_segments: string | null;
  audio_received: number;
  judge_score: string | null;
  judge_grade: string | null;
  judge_quotes: string | null;
  judge_gaps: string | null;
  judge_summary: string | null;
  answer_summary: string | null;
  answer_version: number | null;
  followup_question: string | null;
  follow_ups: string | null;
  attachments: string | null;
  answer_started_at: string | null;
  answer_completed_at: string | null;
  created_at: string;
  audio_key: string | null;
  audio_sample_rate: number | null;
}

function questionToJson(q: QuestionRow) {
  return {
    questionId: q.question_id,
    stage: q.stage || undefined,
    category: q.category || undefined,
    dimension: q.dimension || undefined,
    signal: q.signal || undefined,
    originalQuestion: q.prompt,
    status: q.status,
    rawTranscript: q.raw_transcript || "",
    correctedTranscript: q.answer_transcript || "",
    answerSummary: q.answer_summary || "",
    answerVersion: q.answer_version || 0,
    transcriptSegments: fromJson(q.transcript_segments, [] as unknown[]),
    audioReceived: q.audio_received || 0,
    judge: q.judge_grade || q.judge_score || q.judge_summary
      ? {
          score: q.judge_score || undefined,
          grade: q.judge_grade || undefined,
          quotes: fromJson(q.judge_quotes, [] as string[]),
          gaps: fromJson(q.judge_gaps, [] as string[]),
          summary: q.judge_summary || undefined,
        }
      : undefined,
    followUpQuestion: q.followup_question || undefined,
    followUps: fromJson(q.follow_ups, [] as unknown[]),
    attachments: fromJson(q.attachments, [] as unknown[]),
    answerStartedAt: q.answer_started_at || undefined,
    answerCompletedAt: q.answer_completed_at || undefined,
    // 录音已收到但转写为空 + 有 COS 备份 => 转写失败、可重转(区别于"候选人没作答")
    audioBackup: !!q.audio_key,
  };
}

export function sessionToJson(row: SessionRow) {
  const questions = (getDb()
    .prepare("SELECT * FROM interview_questions WHERE interview_id = ? ORDER BY ord ASC, created_at ASC")
    .all(row.id) as QuestionRow[]).map(questionToJson);
  return {
    id: row.id,
    candidateId: row.candidate_id || undefined,
    candidateName: row.candidate_name || undefined,
    candidateRole: row.candidate_role || undefined,
    feishuRecordId: row.feishu_record_id || undefined,
    candidateLinkToken: row.invite_token || undefined,
    inviteExpiresAt: row.invite_expires_at || undefined,
    roomToken: row.room_token || undefined,
    bookingId: row.booking_id || undefined,
    bookingToken: row.booking_token || undefined,
    bookingRoomToken: row.booking_room_token || undefined,
    status: row.status,
    currentQuestionId: row.current_question_id || undefined,
    hostStartedAt: row.host_started_at || undefined,
    hostEndedAt: row.host_ended_at || undefined,
    candidateEnteredAt: row.candidate_entered_at || undefined,
    candidateLastSeenAt: row.candidate_last_seen_at || undefined,
    candidateViewingQuestionId: row.candidate_viewing_question_id || undefined,
    candidateStage: row.candidate_stage || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    questions,
  };
}

export function getSessionRow(id: string): SessionRow | undefined {
  return getDb().prepare("SELECT * FROM interviews WHERE id = ?").get(id) as SessionRow | undefined;
}

export function listSessions() {
  const rows = getDb().prepare("SELECT * FROM interviews ORDER BY updated_at DESC").all() as SessionRow[];
  return rows.map(sessionToJson);
}

export function getSession(id: string) {
  const row = getSessionRow(id);
  return row ? sessionToJson(row) : null;
}

/** 取某候选人最新一场面试(详情页用,免拉全部 session)。 */
export function getLatestSessionByCandidate(candidateId: string) {
  const row = getDb()
    .prepare("SELECT * FROM interviews WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(candidateId) as SessionRow | undefined;
  return row ? sessionToJson(row) : null;
}

/** upsert 一个完整会话对象(前端 POST /api/interview-sessions 用,保持兼容)。 */
export function upsertSession(session: Record<string, any>) {
  const db = getDb();
  const now = nowIso();
  const existing = getSessionRow(session.id);
  db.prepare(
    `INSERT INTO interviews (
       id, candidate_id, candidate_name, candidate_role, feishu_record_id,
       invite_token, invite_expires_at, room_token, booking_id, booking_token, booking_room_token,
       status, current_question_id, host_started_at, host_ended_at,
       candidate_entered_at, candidate_last_seen_at, candidate_viewing_question_id, candidate_stage, created_at, updated_at
     ) VALUES (
       @id, @candidate_id, @candidate_name, @candidate_role, @feishu_record_id,
       @invite_token, @invite_expires_at, @room_token, @booking_id, @booking_token, @booking_room_token,
       @status, @current_question_id, @host_started_at, @host_ended_at,
       @candidate_entered_at, @candidate_last_seen_at, @candidate_viewing_question_id, @candidate_stage, @created_at, @updated_at
     )
     ON CONFLICT(id) DO UPDATE SET
       candidate_id=excluded.candidate_id, candidate_name=excluded.candidate_name,
       candidate_role=excluded.candidate_role, feishu_record_id=excluded.feishu_record_id,
       invite_token=excluded.invite_token, invite_expires_at=excluded.invite_expires_at,
       room_token=excluded.room_token, booking_id=excluded.booking_id,
       booking_token=excluded.booking_token, booking_room_token=excluded.booking_room_token,
       status=excluded.status, current_question_id=excluded.current_question_id,
       host_started_at=excluded.host_started_at, host_ended_at=excluded.host_ended_at,
       candidate_entered_at=excluded.candidate_entered_at, candidate_last_seen_at=excluded.candidate_last_seen_at,
       candidate_viewing_question_id=excluded.candidate_viewing_question_id, candidate_stage=excluded.candidate_stage,
       updated_at=excluded.updated_at`
  ).run({
    id: session.id,
    candidate_id: session.candidateId ?? null,
    candidate_name: session.candidateName ?? null,
    candidate_role: session.candidateRole ?? null,
    feishu_record_id: session.feishuRecordId ?? null,
    invite_token: session.candidateLinkToken ?? session.inviteToken ?? null,
    invite_expires_at: session.inviteExpiresAt ?? null,
    room_token: session.roomToken ?? null,
    booking_id: session.bookingId ?? null,
    booking_token: session.bookingToken ?? null,
    booking_room_token: session.bookingRoomToken ?? null,
    status: session.status ?? "ready",
    current_question_id: session.currentQuestionId ?? null,
    host_started_at: session.hostStartedAt ?? null,
    host_ended_at: session.hostEndedAt ?? null,
    candidate_entered_at: session.candidateEnteredAt ?? null,
    candidate_last_seen_at: session.candidateLastSeenAt ?? null,
    candidate_viewing_question_id: session.candidateViewingQuestionId ?? null,
    candidate_stage: session.candidateStage ?? null,
    created_at: existing?.created_at ?? session.createdAt ?? now,
    updated_at: now,
  });
  // 同步问题
  if (Array.isArray(session.questions)) {
    replaceQuestions(session.id, session.questions);
  }
  return getSession(session.id);
}

export function replaceQuestions(interviewId: string, questions: Array<Record<string, any>>) {
  const db = getDb();
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM interview_questions WHERE interview_id = ?").run(interviewId);
    const ins = db.prepare(
      `INSERT INTO interview_questions (
         id, interview_id, question_id, ord, stage, category, dimension, signal, prompt, status,
         raw_transcript, answer_transcript, transcript_segments, audio_received,
         judge_score, judge_grade, judge_quotes, judge_gaps, judge_summary, answer_summary, answer_version,
         followup_question, follow_ups, attachments, answer_started_at, answer_completed_at, created_at
       ) VALUES (
         @id, @interview_id, @question_id, @ord, @stage, @category, @dimension, @signal, @prompt, @status,
         @raw_transcript, @answer_transcript, @transcript_segments, @audio_received,
         @judge_score, @judge_grade, @judge_quotes, @judge_gaps, @judge_summary, @answer_summary, @answer_version,
         @followup_question, @follow_ups, @attachments, @answer_started_at, @answer_completed_at, @created_at
       )`
    );
    questions.forEach((q, index) => {
      const judge = q.judge || {};
      const questionId = String(q.questionId ?? q.id ?? `q-${index}`);
      ins.run({
        id: `${interviewId}::${questionId}`,
        interview_id: interviewId,
        question_id: questionId,
        ord: typeof q.ord === "number" ? q.ord : index,
        stage: q.stage ?? null,
        category: q.category ?? null,
        dimension: q.dimension ?? null,
        signal: q.signal ?? null,
        prompt: q.originalQuestion ?? q.prompt ?? "",
        status: q.status ?? "pending",
        raw_transcript: q.rawTranscript ?? "",
        answer_transcript: q.correctedTranscript ?? q.answerTranscript ?? "",
        transcript_segments: toJson(q.transcriptSegments ?? []),
        audio_received: typeof q.audioReceived === "number" ? q.audioReceived : 0,
        judge_score: judge.score ?? q.judgeScore ?? null,
        judge_grade: judge.grade ?? q.judgeGrade ?? null,
        judge_quotes: toJson(judge.quotes ?? null),
        judge_gaps: toJson(judge.gaps ?? null),
        judge_summary: judge.summary ?? null,
        answer_summary: q.answerSummary ?? null,
        answer_version: typeof q.answerVersion === "number" ? q.answerVersion : 0,
        followup_question: q.followUpQuestion ?? null,
        follow_ups: toJson(q.followUps ?? []),
        attachments: toJson(q.attachments ?? []),
        answer_started_at: q.answerStartedAt ?? null,
        answer_completed_at: q.answerCompletedAt ?? null,
        created_at: q.createdAt ?? now,
      });
    });
  });
  tx();
}

/** 读取-改-写一个会话(用于细粒度状态更新),返回更新后的 session JSON。 */
export function mutateSession(id: string, mutator: (session: any) => any) {
  const current = getSession(id);
  if (!current) return null;
  const next = mutator(current);
  return upsertSession(next);
}

function sessionMatchesToken(session: any, token: string): boolean {
  return [session.roomToken, session.bookingToken, session.bookingId, session.bookingRoomToken, session.candidateLinkToken]
    .filter(Boolean)
    .includes(token);
}

export function resolveRoomState(token: string) {
  const all = listSessions().filter((s) => sessionMatchesToken(s, token));
  const active = all.find((s) => s.status !== "completed" && s.status !== "terminated");
  const session = active || all[0] || null;
  return {
    session,
    currentQuestion: session?.questions.find((q: any) => q.questionId === session.currentQuestionId) || null,
  };
}

// ── 细粒度状态变更(经 mutateSession 持久化) ──
const mapQuestion = (s: any, qid: string, fn: (q: any) => any) => ({
  ...s,
  questions: s.questions.map((q: any) => (q.questionId === qid ? fn(q) : q)),
});

/** 后台推送某题:置为当前题并清空该题旧作答。直接 SQL(只动会话行 + 该题一行,不重写整套题)。 */
export function pushQuestion(id: string, questionId: string) {
  const db = getDb();
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare("UPDATE interviews SET status='in_progress', current_question_id=?, updated_at=? WHERE id=?").run(questionId, now, id);
    db.prepare(
      `UPDATE interview_questions SET status='pushed', answer_started_at=NULL, answer_completed_at=NULL,
         raw_transcript='', answer_transcript='', transcript_segments=NULL, audio_received=0, attachments=NULL, follow_ups=NULL
       WHERE interview_id=? AND question_id=?`
    ).run(id, questionId);
  });
  tx();
}

/** 改会话状态。直接 SQL,不触碰题目表(原先经 mutateSession 会把整套题 DELETE+INSERT 重写)。 */
export function setSessionStatus(id: string, statusValue: string) {
  const status = ["ready", "in_progress", "completed", "terminated"].includes(statusValue) ? statusValue : "ready";
  const now = nowIso();
  getDb()
    .prepare(
      `UPDATE interviews SET status=?,
         host_started_at = CASE WHEN ?='in_progress' AND host_started_at IS NULL THEN ? ELSE host_started_at END,
         host_ended_at   = CASE WHEN ? IN ('completed','terminated') THEN ? ELSE host_ended_at END,
         updated_at=?
       WHERE id=?`
    )
    .run(status, status, now, status, now, now, id);
}

/** 候选人在线心跳 + 当前步骤上报。直接 SQL(不重写题目,轻量)。
 *  只有进入答题/作品阶段(stage 以 interview 开头或 works)才落 candidate_entered_at —— 它是总时长截止的锚点,
 *  设备检测/拍照不应启动倒计时。 */
export function updateCandidatePresence(id: string, questionId: string, stage?: string) {
  const now = nowIso();
  const st = (stage || "").trim();
  const anchors = st.startsWith("interview") || st === "works";
  getDb()
    .prepare(
      `UPDATE interviews SET
         candidate_entered_at = COALESCE(candidate_entered_at, ?),
         candidate_last_seen_at = ?,
         candidate_viewing_question_id = COALESCE(NULLIF(?, ''), candidate_viewing_question_id, current_question_id),
         candidate_stage = COALESCE(NULLIF(?, ''), candidate_stage),
         updated_at = ?
       WHERE id = ?`
    )
    .run(anchors ? now : null, now, questionId || "", st, now, id);
}

/** 候选人开始答某题。直接 SQL:会话锚点(进入时间/阶段/在线)+ 该题置 recording。 */
export function startQuestionAnswer(id: string, questionId: string, startedAt: string) {
  const db = getDb();
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE interviews SET candidate_entered_at=COALESCE(candidate_entered_at, ?),
         candidate_stage=COALESCE(candidate_stage, 'interview'), candidate_last_seen_at=?,
         candidate_viewing_question_id=COALESCE(NULLIF(?, ''), current_question_id, candidate_viewing_question_id),
         updated_at=? WHERE id=?`
    ).run(now, now, questionId || "", now, id);
    db.prepare(
      `UPDATE interview_questions SET status=CASE WHEN status='answered' THEN 'answered' ELSE 'recording' END,
         answer_started_at=COALESCE(answer_started_at, ?) WHERE interview_id=? AND question_id=?`
    ).run(startedAt || now, id, questionId);
  });
  tx();
}

/** 候选人整段文字作答:追加到该题转写,回执 +1。 */
export function appendTextAnswer(id: string, questionId: string, text: string, segmentIndex?: number) {
  return mutateSession(id, (s) =>
    mapQuestion(s, questionId, (q) => {
      const segments = Array.isArray(q.transcriptSegments) ? q.transcriptSegments : [];
      const seg = { index: typeof segmentIndex === "number" ? segmentIndex : segments.length, text, at: nowIso() };
      const nextSegments = [...segments, seg];
      const merged = nextSegments.map((x: any) => x.text).filter(Boolean).join("\n");
      return {
        ...q,
        status: "recording",
        transcriptSegments: nextSegments,
        rawTranscript: merged,
        correctedTranscript: merged,
        audioReceived: nextSegments.length,
      };
    })
  );
}

/** 异步流程:候选人上传整段录音后立即回执(不等转写)。重答会覆盖。直接 SQL,只动该题一行。
 *  自增 answer_version 并返回——供后台转写写回时校验,避免旧录音的转写覆盖新录音。 */
export function markAnswerReceived(id: string, questionId: string): number {
  const db = getDb();
  db.prepare(
    `UPDATE interview_questions SET status='recording', audio_received=1,
       answer_version=COALESCE(answer_version,0)+1,
       answer_started_at=COALESCE(answer_started_at, ?),
       transcript_segments=NULL, raw_transcript='', answer_transcript='',
       audio_key=NULL, audio_sample_rate=NULL
     WHERE interview_id=? AND question_id=?`
  ).run(nowIso(), id, questionId);
  const r = db.prepare("SELECT answer_version v FROM interview_questions WHERE interview_id=? AND question_id=?").get(id, questionId) as { v: number } | undefined;
  return r?.v ?? 0;
}

export function completeQuestion(id: string, questionId: string) {
  getDb()
    .prepare("UPDATE interview_questions SET status='answered', answer_completed_at=? WHERE interview_id=? AND question_id=?")
    .run(nowIso(), id, questionId);
}

export function addFollowUp(id: string, questionId: string, followUp: Record<string, unknown>) {
  return mutateSession(id, (s) =>
    mapQuestion(s, questionId, (q) => ({
      ...q,
      followUps: [...(Array.isArray(q.followUps) ? q.followUps : []), { ...followUp, at: nowIso() }],
    }))
  );
}

/** 直接写某题的转写文本(整段一次转写后)。expectVersion 给定时,仅当该题版本未变才写,
 *  避免候选人重答后,旧录音的转写回写覆盖新录音。 */
export function setQuestionTranscript(interviewId: string, questionId: string, transcript: string, audioReceived?: number, expectVersion?: number) {
  const sql = expectVersion == null
    ? `UPDATE interview_questions SET raw_transcript=?, answer_transcript=?, audio_received=COALESCE(?, audio_received) WHERE interview_id=? AND question_id=?`
    : `UPDATE interview_questions SET raw_transcript=?, answer_transcript=?, audio_received=COALESCE(?, audio_received) WHERE interview_id=? AND question_id=? AND answer_version=?`;
  const args: any[] = [transcript, transcript, audioReceived ?? null, interviewId, questionId];
  if (expectVersion != null) args.push(expectVersion);
  getDb().prepare(sql).run(...args);
}

/** 转写失败时记录该题备份录音的 COS key + 采样率(供后续重转)。
 *  expectVersion 给定时仅当版本未变才写,避免候选人已重答后把旧录音的备份引用写回。 */
export function setQuestionAudioKey(interviewId: string, questionId: string, audioKey: string, sampleRate: number, expectVersion?: number) {
  const sql = expectVersion == null
    ? "UPDATE interview_questions SET audio_key=?, audio_sample_rate=? WHERE interview_id=? AND question_id=?"
    : "UPDATE interview_questions SET audio_key=?, audio_sample_rate=? WHERE interview_id=? AND question_id=? AND answer_version=?";
  const args: any[] = [audioKey, sampleRate, interviewId, questionId];
  if (expectVersion != null) args.push(expectVersion);
  getDb().prepare(sql).run(...args);
}

/** 重转成功后清除备份引用(COS 对象由调用方决定是否删除)。 */
export function clearQuestionAudioKey(interviewId: string, questionId: string) {
  getDb()
    .prepare("UPDATE interview_questions SET audio_key=NULL, audio_sample_rate=NULL WHERE interview_id=? AND question_id=?")
    .run(interviewId, questionId);
}

/** 读单题当前行(重转写回前用于校验版本/备份 key 未变,避免覆盖候选人重答的新内容)。 */
export function getQuestionRow(interviewId: string, questionId: string): QuestionRow | null {
  return (getDb()
    .prepare("SELECT * FROM interview_questions WHERE interview_id=? AND question_id=?")
    .get(interviewId, questionId) as QuestionRow) || null;
}

/** 把某候选人所有"还没结束"的面试置为 terminated(重新发起面试前调用,避免旧场成为孤儿一直在工作台报警)。 */
export function terminateOpenByCandidate(candidateId: string, exceptId?: string): number {
  const now = nowIso();
  const r = getDb()
    .prepare(
      `UPDATE interviews SET status='terminated', host_ended_at=?, updated_at=?
       WHERE candidate_id=? AND status NOT IN ('completed','terminated')` + (exceptId ? " AND id != ?" : "")
    )
    .run(...(exceptId ? [now, now, candidateId, exceptId] : [now, now, candidateId]));
  return r.changes;
}

/** 写某题的 AI 评判(分数/等级/原话引用/未讲清点)。 */
export function setQuestionJudgement(
  interviewId: string,
  questionId: string,
  judge: { grade: string; score: string; quotes: string[]; gaps: string[]; summary: string }
) {
  getDb()
    .prepare(
      `UPDATE interview_questions SET judge_grade=?, judge_score=?, judge_quotes=?, judge_gaps=?, judge_summary=?
       WHERE interview_id = ? AND question_id = ?`
    )
    .run(judge.grade, judge.score, toJson(judge.quotes), toJson(judge.gaps), judge.summary, interviewId, questionId);
}

/** 写某题的回答整理稿(逻辑重排 + 改错字 + 小结),与评判解耦,单独一次 AI 调用产出。 */
export function setQuestionAnswerSummary(interviewId: string, questionId: string, text: string) {
  getDb()
    .prepare("UPDATE interview_questions SET answer_summary=? WHERE interview_id = ? AND question_id = ?")
    .run(text, interviewId, questionId);
}

/** 写某题自动生成的追问。 */
export function setQuestionFollowUpQuestion(interviewId: string, questionId: string, followupQuestion: string) {
  getDb()
    .prepare("UPDATE interview_questions SET followup_question = ? WHERE interview_id = ? AND question_id = ?")
    .run(followupQuestion, interviewId, questionId);
}

/** 读单题(给评判/追问用)。 */
export function getQuestion(interviewId: string, questionId: string) {
  const row = getDb()
    .prepare("SELECT * FROM interview_questions WHERE interview_id = ? AND question_id = ?")
    .get(interviewId, questionId) as QuestionRow | undefined;
  return row || null;
}

export function listQuestionRows(interviewId: string): QuestionRow[] {
  return getDb()
    .prepare("SELECT * FROM interview_questions WHERE interview_id = ? ORDER BY ord ASC, created_at ASC")
    .all(interviewId) as QuestionRow[];
}

/** 创建一场异步面试会话(带邀约 token + 48h 有效期)。 */
export function createInterview(opts: {
  candidateId?: string; candidateName?: string; candidateRole?: string; feishuRecordId?: string;
  questions: Array<Record<string, any>>; inviteTtlHours: number;
}) {
  const now = nowIso();
  const id = `itv-${crypto.randomUUID()}`;
  const inviteToken = `inv-${crypto.randomUUID().slice(0, 12)}`;
  const expires = new Date(Date.now() + opts.inviteTtlHours * 3600 * 1000).toISOString();
  upsertSession({
    id,
    candidateId: opts.candidateId,
    candidateName: opts.candidateName,
    candidateRole: opts.candidateRole,
    feishuRecordId: opts.feishuRecordId,
    candidateLinkToken: inviteToken,
    inviteExpiresAt: expires,
    roomToken: `room-${id}`,
    status: "ready",
    createdAt: now,
    questions: opts.questions,
  });
  return { id, inviteToken, inviteExpiresAt: expires, session: getSession(id) };
}

/** 后台「重新开启」:同一场面试(同链接、同题目)重置为可重新作答 + 续期链接。
 *  会清空原作答/转写/评判与计时锚点,让候选人重新从头做;附件(作品集)保留。 */
export function reopenInterview(id: string, inviteTtlHours: number) {
  const db = getDb();
  const now = nowIso();
  const expires = new Date(Date.now() + inviteTtlHours * 3600 * 1000).toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE interviews SET
         status='ready', invite_expires_at=?, current_question_id=NULL,
         host_started_at=NULL, host_ended_at=NULL,
         candidate_entered_at=NULL, candidate_last_seen_at=NULL, candidate_viewing_question_id=NULL,
         updated_at=?
       WHERE id=?`
    ).run(expires, now, id);
    db.prepare(
      `UPDATE interview_questions SET
         status='pending', answer_started_at=NULL, answer_completed_at=NULL, audio_received=0,
         raw_transcript='', answer_transcript='', transcript_segments=NULL,
         judge_grade=NULL, judge_score=NULL, judge_quotes=NULL, judge_gaps=NULL, judge_summary=NULL,
         followup_question=NULL, follow_ups=NULL, audio_key=NULL, audio_sample_rate=NULL
       WHERE interview_id=?`
    ).run(id);
  });
  tx();
  return getSession(id);
}

/** 凭邀约 token 解析会话(候选人公开入口),并判断是否过期。 */
export function resolveByInviteToken(token: string) {
  const row = getDb().prepare("SELECT * FROM interviews WHERE invite_token = ?").get(token) as SessionRow | undefined;
  if (!row) return { found: false as const };
  const expired = Boolean(row.invite_expires_at && new Date(row.invite_expires_at).getTime() < Date.now());
  return { found: true as const, expired, session: sessionToJson(row) };
}
