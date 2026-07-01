// 候选人档案分享链接仓库。生成只读分享 token,支持按查看次数 / 到期时间失效,以及手动撤销。
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "../db.js";

export interface ShareLink {
  token: string;
  candidateId: string;
  maxViews?: number;      // 不限次数时为 undefined
  validUntil?: string;    // ISO,不限时间时为 undefined
  viewCount: number;
  revoked: boolean;
  note?: string;
  createdAt: string;
  lastViewedAt?: string;
}

export type ShareStatus = "active" | "revoked" | "expired" | "exhausted";

function toJson(r: any): ShareLink {
  return {
    token: r.token,
    candidateId: r.candidate_id,
    maxViews: r.max_views == null ? undefined : Number(r.max_views),
    validUntil: r.valid_until || undefined,
    viewCount: Number(r.view_count) || 0,
    revoked: !!r.revoked,
    note: r.note || undefined,
    createdAt: r.created_at,
    lastViewedAt: r.last_viewed_at || undefined,
  };
}

/** 判断链接当前有效性。exhausted 用 viewCount >= maxViews 判断(在本次计数之前调用):
 *  maxViews=2 时,第 1、2 次访问放行(viewCount 0、1),第 3 次(viewCount 2)判为 exhausted。 */
export function shareStatus(link: ShareLink, now = Date.now()): ShareStatus {
  if (link.revoked) return "revoked";
  if (link.validUntil && new Date(link.validUntil).getTime() < now) return "expired";
  if (link.maxViews != null && link.viewCount >= link.maxViews) return "exhausted";
  return "active";
}

export function createShareLink(input: {
  candidateId: string;
  maxViews?: number | null;
  validUntil?: string | null;
  note?: string | null;
}): ShareLink {
  const db = getDb();
  const token = `sh-${randomUUID().slice(0, 12)}`;
  const maxViews = input.maxViews != null && Number.isFinite(Number(input.maxViews)) && Number(input.maxViews) > 0
    ? Math.round(Number(input.maxViews)) : null;
  const validUntil = input.validUntil && String(input.validUntil).trim() ? String(input.validUntil).trim() : null;
  db.prepare(
    `INSERT INTO share_links (token, candidate_id, max_views, valid_until, view_count, revoked, note, created_at, last_viewed_at)
     VALUES (@token, @candidate_id, @max_views, @valid_until, 0, 0, @note, @created_at, NULL)`
  ).run({
    token, candidate_id: input.candidateId, max_views: maxViews, valid_until: validUntil,
    note: input.note ? String(input.note).slice(0, 500) : null, created_at: nowIso(),
  });
  return getShareLink(token)!;
}

export function getShareLink(token: string): ShareLink | null {
  const r = getDb().prepare("SELECT * FROM share_links WHERE token = ?").get(token);
  return r ? toJson(r) : null;
}

export function listShareLinksByCandidate(candidateId: string): ShareLink[] {
  return (getDb().prepare("SELECT * FROM share_links WHERE candidate_id = ? ORDER BY created_at DESC").all(candidateId) as any[]).map(toJson);
}

/** 记一次成功查看:view_count +1,更新 last_viewed_at。 */
export function incrementView(token: string): void {
  getDb().prepare("UPDATE share_links SET view_count = view_count + 1, last_viewed_at = ? WHERE token = ?").run(nowIso(), token);
}

export function revokeShareLink(token: string): boolean {
  return getDb().prepare("UPDATE share_links SET revoked = 1 WHERE token = ?").run(token).changes > 0;
}
