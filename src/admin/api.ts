// 管理后台 API 客户端。所有请求带 cookie(credentials:include);401 抛 Unauthorized。
export class Unauthorized extends Error {}

/** 复制文本到剪贴板。HTTP(非安全上下文,如局域网 IP 直连)下 navigator.clipboard 不可用,回退 execCommand。
 *  返回是否真的复制成功——调用方据此提示,避免"明明没复制却提示已复制"。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* 回退 */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

async function req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  // 非 GET 一律带 application/json + 空 body{}:Cloudflare 隧道下"无 body 的 POST"会被 Fastify 拒成 415
  const hasJsonBody = method.toUpperCase() !== "GET";
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: hasJsonBody ? { "Content-Type": "application/json" } : undefined,
    body: hasJsonBody ? JSON.stringify(body ?? {}) : undefined,
  });
  if (res.status === 401) throw new Unauthorized("未登录");
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json && json.ok === false)) {
    throw new Error((json && json.error) || `请求失败 ${res.status}`);
  }
  return json as T;
}

export const api = {
  // 鉴权
  login: (password: string) => req("POST", "/api/auth/login", { password }),
  logout: () => req("POST", "/api/auth/logout"),
  me: () => req<{ authenticated: boolean }>("GET", "/api/auth/me"),

  // 今日工作台
  today: () => req<{ workbench: any }>("GET", "/api/today"),

  // 人才库
  candidates: () => req<{ candidates: any[] }>("GET", "/api/candidates"),
  candidate: (id: string) => req<{ candidate: any }>("GET", `/api/candidates/${encodeURIComponent(id)}`),
  candidateInterview: (id: string) => req<{ interview: any }>("GET", `/api/candidates/${encodeURIComponent(id)}/interview`),
  candidateDetail: (id: string) => req<{ candidate: any; screening: any; interview: any; evaluation: any; secondInterview: any; attachments: any[] }>("GET", `/api/candidates/${encodeURIComponent(id)}/detail`),
  candidatePhoto: (id: string) => req<{ photo: string | null }>("GET", `/api/candidates/${encodeURIComponent(id)}/photo`),
  setResult: (id: string, payload: { result: "pass" | "reject" | null; note: string }) => req<{ candidate: any; sms?: { sent: boolean; reason?: string } }>("POST", `/api/candidates/${encodeURIComponent(id)}/result`, payload),
  setLocation: (id: string, payload: { current: string; expect: string }) => req<{ candidate: any }>("POST", `/api/candidates/${encodeURIComponent(id)}/location`, payload),
  setStar: (id: string, starred: boolean) => req<{ starred: boolean }>("POST", `/api/candidates/${encodeURIComponent(id)}/star`, { starred }),
  interviewsLive: () => req<{ live: Record<string, any> }>("GET", `/api/interviews/live`),
  cleanupStale: (days: number) => req<{ count: number; cleared: Array<{ id: string; name: string }> }>("POST", `/api/candidates/cleanup-stale`, { days }),
  generateMissingReports: () => req<{ count: number; candidates: Array<{ id: string; name: string }> }>("POST", `/api/interviews/generate-missing-reports`),
  compareCandidates: (ids: string[], focus: string) => req<{ ranking: Array<{ id: string; name: string; rank: number; score: number; dims: { resume: number; interview: number; quality: number }; oneLine: string; reason: string }>; summary: string }>("POST", `/api/candidates/compare`, { ids, focus }),
  createCollection: (payload: { name: string; role?: string; type: "anchor" | "normal"; focus?: string; counts?: Array<{ key: string; name: string; n: number }> }) => req<{ token: string; url: string; candidateId: string; type: string; questions: Array<{ id: string; q: string; hint?: string; category?: string }> }>("POST", `/api/collections`, payload),
  collectionCategories: (type: "anchor" | "normal") => req<{ categories: Array<{ key: string; name: string; n: number }> }>("GET", `/api/collections/categories?type=${type}`),
  collectionByCandidate: (id: string) => req<{ collection: any }>("GET", `/api/collections/by-candidate/${encodeURIComponent(id)}`),
  updateCollectionQuestions: (token: string, questions: Array<{ id?: string; q: string; hint?: string }>) => req<{ questions: any[] }>("POST", `/api/collections/${encodeURIComponent(token)}/questions`, { questions }),
  deleteCollectionVideo: (token: string) => req<{ deleted: boolean }>("POST", `/api/collections/${encodeURIComponent(token)}/delete-video`),
  collectionVideoUrl: (token: string) => req<{ url: string }>("GET", `/api/collections/${encodeURIComponent(token)}/video-url`),
  collectionAnswerVideoUrl: (token: string, qid: string) => req<{ url: string }>("GET", `/api/collections/${encodeURIComponent(token)}/answer-video-url?qid=${encodeURIComponent(qid)}`),
  deleteCollectionAnswerVideo: (token: string, qid: string) => req<{ deleted: boolean }>("POST", `/api/collections/${encodeURIComponent(token)}/delete-answer-video`, { qid }),
  evaluateCollection: (token: string) => req<{ evaluation: any }>("POST", `/api/collections/${encodeURIComponent(token)}/evaluate`),
  deleteCandidate: (id: string) => req<{ deleted: boolean }>("DELETE", `/api/candidates/${encodeURIComponent(id)}`),
  genResultReason: (id: string, result: "pass" | "reject") => req<{ note: string }>("POST", `/api/candidates/${encodeURIComponent(id)}/result-reason`, { result }),
  candidateScreening: (id: string) => req<{ screening: any }>("GET", `/api/candidates/${encodeURIComponent(id)}/screening`),
  screenCandidate: (id: string) => req<{ screening: any }>("POST", `/api/candidates/${encodeURIComponent(id)}/screen`),
  regenerateQuestion: (id: string, payload: { dimension?: string; currentQuestion?: string; steer: string }) =>
    req<{ question: string }>("POST", `/api/candidates/${encodeURIComponent(id)}/regenerate-question`, payload),
  questionPlan: (id: string) =>
    req<{ role: string; positionId: string; positionRole: string; dimensions: Array<{ key: string; name: string; weight: number }>; suggested: { total: number; counts: Array<{ key: string; name: string; weight: number; n: number }> } }>(
      "GET", `/api/candidates/${encodeURIComponent(id)}/question-plan`),
  generateQuestions: (id: string, payload: { counts: Array<{ key?: string; dimension?: string; name?: string; n: number }> }) =>
    req<{ questions: Array<{ questionId: string; dimension: string; question: string }> }>(
      "POST", `/api/candidates/${encodeURIComponent(id)}/generate-questions`, payload),
  runScreening: (limit?: number) => req<{ screened: number; results: any[] }>("POST", "/api/screenings/run", { limit }),
  addCandidate: (c: any) => req<{ candidate: any }>("POST", "/api/candidates", c),
  syncFeishu: () => req<{ imported: number; total: number; tableUrl: string }>("POST", "/api/feishu/resumes/sync"),
  resumeLibrary: () => req<{ url: string | null; name: string }>("GET", "/api/feishu/resume-library"),

  // 面试
  interviews: () => req<{ sessions: any[] }>("GET", "/api/interview-sessions"),
  createInterview: (payload: any) => req<{ interviewId: string; inviteToken: string; inviteExpiresAt: string; inviteUrl: string }>("POST", "/api/interviews", payload),
  report: (interviewId: string) => req<{ evaluation: any }>("GET", `/api/interviews/${encodeURIComponent(interviewId)}/report`),
  generateReport: (interviewId: string) => req<{ report: any; evaluation: any }>("POST", `/api/interviews/${encodeURIComponent(interviewId)}/report`),
  reopenInterview: (interviewId: string) => req<{ interview: any; inviteUrl?: string; inviteExpiresAt?: string }>("POST", `/api/interviews/${encodeURIComponent(interviewId)}/reopen`),
  retranscribeInterview: (interviewId: string) => req<{ total: number; retranscribed: number; failed: number; skipped: number }>("POST", `/api/interviews/${encodeURIComponent(interviewId)}/retranscribe`),
  candidateLive: (id: string) => req<{ live: any }>("GET", `/api/candidates/${encodeURIComponent(id)}/live`),
  rejudge: (interviewId: string, qid: string) => req("POST", `/api/interviews/${encodeURIComponent(interviewId)}/questions/${encodeURIComponent(qid)}/judge`),

  // 分享链接:把候选人完整档案以只读链接分享给 HR/他人,可设失效次数与到期时间
  shareLinks: (id: string) => req<{ links: any[] }>("GET", `/api/candidates/${encodeURIComponent(id)}/share-links`),
  createShareLink: (id: string, payload: { maxViews?: number | null; validHours?: number | null; note?: string }) =>
    req<{ link: any }>("POST", `/api/candidates/${encodeURIComponent(id)}/share-links`, payload),
  revokeShareLink: (token: string) => req<{ revoked: boolean }>("DELETE", `/api/share-links/${encodeURIComponent(token)}`),

  // 日程
  bookings: () => req<{ bookings: any[] }>("GET", "/api/bookings"),
  reviewBooking: (id: string, reviewStatus: string) => req("PATCH", `/api/bookings/${encodeURIComponent(id)}/review`, { reviewStatus }),
  calendarEvents: (from?: string, to?: string) => req<{ events: any[] }>("GET", `/api/calendar-events${from && to ? `?from=${from}&to=${to}` : ""}`),
  saveCalendarEvent: (e: { id?: string; date: string; title: string; type?: string; startTime?: string; endTime?: string; candidateId?: string; candidateName?: string; note?: string; outcome?: string }) => req<{ event: any }>("POST", "/api/calendar-events", e),
  deleteCalendarEvent: (id: string) => req<{ deleted: boolean }>("DELETE", `/api/calendar-events/${encodeURIComponent(id)}`),
  // 二面:按候选人专属档期
  secondInvite: (id: string, slots: any[]) => req<{ token: string; url: string }>("POST", `/api/candidates/${encodeURIComponent(id)}/second-invite`, { slots }),
  secondInterview: (id: string) => req<{ invite: any; booking: any; bookedSlots?: any[] }>("GET", `/api/candidates/${encodeURIComponent(id)}/second-interview`),

  // 设置:多岗位画像 + 加权评分标准
  jobProfile: () => req<{ config: any }>("GET", "/api/settings/job-profile"),
  saveJobProfile: (config: any) => req<{ config: any }>("POST", "/api/settings/job-profile", config),
  brandConfig: () => req<{ brand: { companyName: string; tagline: string } }>("GET", "/api/settings/brand"),
  saveBrand: (b: { companyName: string; tagline: string }) => req<{ brand: { companyName: string; tagline: string } }>("POST", "/api/settings/brand", b),
  interviewSettings: () => req<{ settings: { answerLimitSec: number; maxDurationMin: number; inviteTtlHours: number } }>("GET", "/api/settings/interview"),
  saveInterviewSettings: (s: { answerLimitSec: number; maxDurationMin: number; inviteTtlHours: number }) => req<{ settings: { answerLimitSec: number; maxDurationMin: number; inviteTtlHours: number } }>("POST", "/api/settings/interview", s),
  aiConfig: () => req<{ config: any }>("GET", "/api/ai-config"),
  saveAiConfig: (c: any) => req("POST", "/api/ai-config", c),
};
