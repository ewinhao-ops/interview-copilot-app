// 候选人档案分享链接路由。
// 后台(需登录):为候选人生成/列出/撤销分享链接。
// 公开(/api/public/share/*,免登录,凭 token):只读查看候选人完整档案 + 回放答题附件。
import type { FastifyInstance, FastifyReply } from "fastify";
import * as Candidates from "../repo/candidates.js";
import * as Interviews from "../repo/interviews.js";
import * as Attachments from "../repo/attachments.js";
import {
  createShareLink, getShareLink, listShareLinksByCandidate,
  incrementView, revokeShareLink, shareStatus, type ShareLink,
} from "../repo/share-links.js";
import { buildDossier } from "../services/candidate-dossier.js";
import { sendAttachment } from "./async-interview.js";

function ok(reply: FastifyReply, payload: Record<string, unknown> = {}) {
  return reply.send({ ok: true, ...payload });
}

// 给后台展示的链接对象:附上当前状态与相对访问路径。
function decorate(link: ShareLink) {
  return {
    ...link,
    status: shareStatus(link),
    url: `/p/share/${link.token}`,
    viewsLeft: link.maxViews != null ? Math.max(0, link.maxViews - link.viewCount) : null,
  };
}

export function registerShareRoutes(app: FastifyInstance) {
  // ── 后台:创建分享链接 ──
  app.post("/api/candidates/:id/share-links", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    if (!Candidates.getCandidate(id)) return reply.code(404).send({ ok: false, error: "candidate_not_found" });
    const body = (req.body || {}) as any;
    // 到期时间:优先显式 validUntil(ISO);否则按 validHours 从现在起算;都没有=不限时间
    let validUntil: string | null = null;
    if (body.validUntil && String(body.validUntil).trim()) {
      validUntil = String(body.validUntil).trim();
    } else if (body.validHours != null && Number(body.validHours) > 0) {
      validUntil = new Date(Date.now() + Number(body.validHours) * 3600 * 1000).toISOString();
    }
    const maxViews = body.maxViews != null && Number(body.maxViews) > 0 ? Math.round(Number(body.maxViews)) : null;
    const link = createShareLink({ candidateId: id, maxViews, validUntil, note: body.note });
    return ok(reply, { link: decorate(link) });
  });

  // ── 后台:列出某候选人的所有分享链接 ──
  app.get("/api/candidates/:id/share-links", async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    return ok(reply, { links: listShareLinksByCandidate(id).map(decorate) });
  });

  // ── 后台:撤销一个分享链接 ──
  app.delete("/api/share-links/:token", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const okDel = revokeShareLink(token);
    if (!okDel) return reply.code(404).send({ ok: false, error: "not_found" });
    return ok(reply, { revoked: true });
  });

  // ── 公开:凭 token 查看候选人完整档案(每次打开计一次查看)──
  app.get("/api/public/share/:token", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const link = getShareLink(token);
    if (!link) return reply.code(404).send({ ok: false, error: "not_found" });
    const status = shareStatus(link);
    if (status !== "active") return reply.code(410).send({ ok: false, error: status });
    // 有效 -> 记一次查看,再聚合档案
    incrementView(token);
    const dossier = buildDossier(link.candidateId);
    if (!dossier) return reply.code(404).send({ ok: false, error: "candidate_gone" });
    const after = getShareLink(token)!; // 取计数后的最新值
    return ok(reply, {
      dossier,
      meta: {
        maxViews: link.maxViews ?? null,
        viewCount: after.viewCount,
        viewsLeft: link.maxViews != null ? Math.max(0, link.maxViews - after.viewCount) : null,
        validUntil: link.validUntil ?? null,
      },
    });
  });

  // ── 公开:回放档案里的答题图片 / 作品视频(校验 token 有效 + 附件确属本候选人;不计入查看次数)──
  app.get("/api/public/share/:token/attachments/:attId/file", async (req, reply) => {
    const token = decodeURIComponent((req.params as any).token);
    const attId = decodeURIComponent((req.params as any).attId);
    const link = getShareLink(token);
    if (!link || shareStatus(link) !== "active") return reply.code(410).send({ ok: false, error: "link_inactive" });
    const att = Attachments.getAttachment(attId);
    if (!att) return reply.code(404).send({ ok: false, error: "attachment_not_found" });
    // 防越权:附件必须属于该候选人最新那场面试
    const interview = Interviews.getLatestSessionByCandidate(link.candidateId);
    if (!interview || att.interview_id !== interview.id) return reply.code(403).send({ ok: false, error: "forbidden" });
    return sendAttachment(req, reply, att);
  });
}
