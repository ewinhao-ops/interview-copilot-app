// 管理后台鉴权:管理员密码登录 -> 签名 cookie 会话。
// 候选人公开页(凭 token)走 isPublicRoute 白名单,无需登录。
// BOSS 自动化等机器调用 POST /api/candidates 用 Bearer ingest token。
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const COOKIE_NAME = "ic_session";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 候选人公开访问的路由白名单(无需管理员登录,但路由内部仍要验 token)。 */
export function isPublicRoute(method: string, path: string): boolean {
  const m = method.toUpperCase();
  // 阶段2 新的候选人异步面试公开入口:凭邀约 token,内部校验有效期
  if (path.startsWith("/api/public/")) return true;
  // 候选人打开二面预约链接 / 提交预约 / 看开放档期
  if (m === "GET" && /^\/api\/booking-links\/[^/]+$/.test(path)) return true;
  if (m === "POST" && path === "/api/bookings") return true;
  if (m === "GET" && path === "/api/availability-ranges") return true;
  // 登录 + 健康检查
  if (path === "/api/auth/login" || path === "/api/auth/me" || path === "/api/auth/logout") return true;
  if (path === "/api/health") return true;
  return false;
}

function makeSessionValue(): string {
  const exp = Date.now() + config.sessionTtlHours * 3600 * 1000;
  return String(exp);
}

function isValidSession(req: FastifyRequest): boolean {
  const raw = (req.cookies as Record<string, string | undefined>)?.[COOKIE_NAME];
  if (!raw) return false;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return false;
  const exp = Number(unsigned.value);
  return Number.isFinite(exp) && exp > Date.now();
}

function hasIngestToken(req: FastifyRequest): boolean {
  if (!config.ingestToken) return false;
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(token) && safeEqual(token, config.ingestToken);
}

export function registerAuth(app: FastifyInstance) {
  // 登录
  app.post("/api/auth/login", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body || {}) as { password?: string };
    if (!body.password || !safeEqual(body.password, config.adminPassword)) {
      return reply.code(401).send({ ok: false, error: "密码错误" });
    }
    // Secure 按访问协议自适应:HTTPS 域名(x-forwarded-proto=https)用 Secure;
    // HTTP 直连 IP 时不加 Secure,否则浏览器拒绝存储 cookie,登录后每个请求都 401(看着像打不开)。
    const proto = String((req.headers["x-forwarded-proto"] || "") as string).split(",")[0].trim();
    const isHttps = proto === "https";
    reply.setCookie(COOKIE_NAME, makeSessionValue(), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: isHttps,
      signed: true,
      maxAge: config.sessionTtlHours * 3600,
    });
    return { ok: true };
  });

  app.post("/api/auth/logout", async (_req, reply: FastifyReply) => {
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req: FastifyRequest) => {
    return { ok: true, authenticated: isValidSession(req) };
  });

  // 全局守卫:非 /api 路由(静态)放行;公开 /api 路由放行;其余要管理员/ingest
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split("?")[0];
    if (!path.startsWith("/api/")) return; // 静态资源
    if (isPublicRoute(req.method, path)) return;
    // BOSS 自动化入库
    if (req.method === "POST" && path === "/api/candidates" && hasIngestToken(req)) return;
    if (isValidSession(req)) return;
    return reply.code(401).send({ ok: false, error: "未登录" });
  });
}
