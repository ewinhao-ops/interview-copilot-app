// 候选人完整档案聚合(只读)。给分享链接的 public 页用:一次取齐个人资料、沟通记录、
// 面试情况与评价、整体评估与反馈。复用后台详情页同一批 repo,附加日历沟通记录。
import * as Candidates from "../repo/candidates.js";
import * as Interviews from "../repo/interviews.js";
import * as Bookings from "../repo/bookings.js";
import * as Screenings from "../repo/screenings.js";
import * as Evaluations from "../repo/evaluations.js";
import * as Attachments from "../repo/attachments.js";
import * as Calendar from "../repo/calendar.js";

export interface CandidateDossier {
  profile: any;                 // 个人资料(含简历全文、学历、所在地、联系方式、照片)
  screening: any;               // 初筛结论
  interview: any;               // 最新一场面试(逐题:题目/转写/整理稿/AI 评判)
  evaluation: any;              // 综合评估报告
  attachments: any[];           // 答题图片 / 作品(元数据,前端按 token 拼回放 url)
  secondInterview: { invite: any; booking: any };
  communications: any[];        // 沟通记录(日历里 type=comm/interview/note 且关联本人)
  result: { result: "pass" | "reject" | null; note?: string; at?: string };
  generatedAt: string;
}

/** 聚合一个候选人的完整档案;候选人不存在返回 null。 */
export function buildDossier(candidateId: string): CandidateDossier | null {
  const candidate: any = Candidates.getCandidate(candidateId);
  if (!candidate) return null;

  const screening = Screenings.getScreeningByCandidate(candidateId);
  const interview = Interviews.getLatestSessionByCandidate(candidateId);
  const evaluation = interview ? Evaluations.getEvaluationByInterview(interview.id) : null;
  const invite = Bookings.findSecondInviteByCandidate(candidateId);
  const booking = Bookings.findBookingByCandidate(candidateId);
  const attachments = interview
    ? Attachments.listMeta(interview.id).map((a: any) => ({
        id: a.id, questionId: a.question_id, kind: a.kind, name: a.name, mime: a.mime, size: a.size,
        type: a.type || ((a.mime || "").startsWith("video/") ? "video" : "image"),
      }))
    : [];
  // 沟通记录:日历中关联本候选人的事件(沟通 / 面试安排 / 备注),按日期升序
  const communications = Calendar.listEvents().filter((e) => e.candidateId === candidateId);

  return {
    profile: candidate,
    screening,
    interview,
    evaluation,
    attachments,
    secondInterview: {
      invite: invite ? { token: invite.token, ...invite.config } : null,
      booking,
    },
    communications,
    result: {
      result: candidate.result ?? null,
      note: candidate.resultNote,
      at: candidate.resultAt,
    },
    generatedAt: new Date().toISOString(),
  };
}
