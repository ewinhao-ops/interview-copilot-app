import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { getDb, getSetting, setSetting } from "./db.js";
import { backfillEducation, backfillLocal } from "./repo/candidates.js";
import { registerAuth } from "./auth.js";
import { registerRoutes } from "./routes.js";
import { registerAsyncInterviewRoutes } from "./routes/async-interview.js";
import { registerScreeningRoutes } from "./routes/screening.js";
import { registerSecondInterviewRoutes } from "./routes/second-interview.js";
import { registerCollectionRoutes } from "./routes/collection.js";
import { registerCalendarRoutes } from "./routes/calendar.js";
import { registerShareRoutes } from "./routes/share.js";
import { startDailyScreeningScheduler } from "./scheduler.js";

export async function buildServer() {
  const app = Fastify({
    logger: { level: config.isProd ? "info" : "warn" },
    bodyLimit: 110 * 1024 * 1024, // 容纳整段转写 + 候选人作品视频(单个上限 100MB)的二进制上传
  });

  // 候选人录音改为二进制(+gzip)上传,避免 base64 膨胀/编码慢
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  getDb(); // 初始化数据库 + 跑迁移
  // 一次性回填存量候选人的学历标注(迁移 008 之后);改进解析逻辑后可清 edu_backfilled 标志重跑
  if (!getSetting<boolean>("edu_backfilled", false)) {
    try { const n = backfillEducation(); setSetting("edu_backfilled", true); console.log(`[edu] 学历标注回填完成: ${n} 人`); } catch (e) { console.error("[edu] 回填失败", e); }
  }
  // 一次性回填"徐州本地"标注 + 现居/期望城市(迁移 013 之后);改进解析后可升级此标志 key 重跑
  if (!getSetting<boolean>("local_backfilled_v2", false)) {
    try { const n = backfillLocal(); setSetting("local_backfilled_v2", true); console.log(`[local] 徐州本地+所在地标注回填完成: ${n} 人`); } catch (e) { console.error("[local] 回填失败", e); }
  }

  await app.register(cookie, { secret: config.cookieSecret });
  registerAuth(app);
  registerRoutes(app);
  registerAsyncInterviewRoutes(app);
  registerScreeningRoutes(app);
  registerSecondInterviewRoutes(app);
  registerCollectionRoutes(app);
  registerCalendarRoutes(app);
  registerShareRoutes(app);
  startDailyScreeningScheduler();

  // 生产:静态托管 admin / public 两个构建
  if (config.serveStatic && existsSync(config.distDir)) {
    await app.register(fastifyStatic, {
      root: config.distDir, prefix: "/",
      cacheControl: false, // 关掉插件自带的 max-age,改由 setHeaders 精确控制
      // HTML(SPA 外壳)绝不缓存:每次都取最新,才能拿到带新哈希的 JS/CSS,避免部署后还加载旧前端;
      // 带哈希的 assets/* 文件名每次构建都变,可长期强缓存。
      setHeaders: (res, path) => {
        if (path.endsWith(".html")) res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        else if (path.includes("/assets/")) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        else res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
      },
    });
    // 候选人公开页与后台 SPA 回退
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ ok: false, error: "not_found" });
      const isPublic = req.url.startsWith("/p/") || req.url.startsWith("/#/booking") || req.url.startsWith("/#/room");
      const file = isPublic && existsSync(join(config.distDir, "public.html")) ? "public.html" : "admin.html";
      reply.header("Cache-Control", "no-cache, no-store, must-revalidate");
      return reply.sendFile(existsSync(join(config.distDir, file)) ? file : "index.html");
    });
  }

  return app;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  buildServer()
    .then((app) => app.listen({ port: config.port, host: config.host }))
    .then((address) => {
      // eslint-disable-next-line no-console
      console.log(`[server] 面试系统后端已启动: ${address}`);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[server] 启动失败", err);
      process.exit(1);
    });
}
