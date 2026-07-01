import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = resolve(here, "..");

dotenv.config({ path: resolve(ROOT_DIR, ".env") });

function envStr(key: string, fallback = ""): string {
  const v = process.env[key];
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  rootDir: ROOT_DIR,
  port: envNum("PORT", 8787),
  host: envStr("HOST", "127.0.0.1"),
  // 数据库放服务器本地磁盘,绝不放 iCloud 同步目录
  databasePath: envStr("DATABASE_PATH", resolve(ROOT_DIR, "data", "interview.db")),
  backupDir: envStr("BACKUP_DIR", resolve(ROOT_DIR, "backups")),
  // 候选人作品(图片/视频)落盘目录:默认放数据库同级 uploads/(部署时在数据目录内,rsync --delete 不会清掉)
  uploadsDir: envStr("UPLOADS_DIR", resolve(dirname(envStr("DATABASE_PATH", resolve(ROOT_DIR, "data", "interview.db"))), "uploads")),
  // 单个作品大小上限(字节):视频 100MB、图片 15MB
  worksVideoMaxBytes: envNum("WORKS_VIDEO_MAX_BYTES", 100 * 1024 * 1024),
  worksImageMaxBytes: envNum("WORKS_IMAGE_MAX_BYTES", 15 * 1024 * 1024),
  worksMaxCount: envNum("WORKS_MAX_COUNT", 5),
  // 管理后台登录
  adminPassword: envStr("ADMIN_PASSWORD", "change-me-in-env"),
  cookieSecret: envStr("COOKIE_SECRET", "dev-insecure-cookie-secret-change-me"),
  sessionTtlHours: envNum("SESSION_TTL_HOURS", 72),
  // BOSS 自动化等机器调用 POST /api/candidates 用的 bearer token
  ingestToken: envStr("INGEST_TOKEN", ""),
  // 生产环境下静态资源目录(admin/public 两个构建)
  distDir: envStr("DIST_DIR", resolve(ROOT_DIR, "dist")),
  serveStatic: envStr("SERVE_STATIC", "") === "1",
  // 飞书 lark-cli(过渡期只读,后退役)
  larkCliPath: envStr("LARK_CLI_PATH", "lark-cli"),
  feishuConfigPath: resolve(ROOT_DIR, "src/renderer/data/feishuResumeBaseConfig.json"),
  // 邀约链接有效期
  inviteTtlHours: envNum("INVITE_TTL_HOURS", 48),
  // 腾讯云短信(结果通知)。全部配齐才会真正发,缺任意一项则静默跳过(候选人手机号照常收集)。
  sms: {
    secretId: envStr("SMS_SECRET_ID", ""),
    secretKey: envStr("SMS_SECRET_KEY", ""),
    sdkAppId: envStr("SMS_SDK_APP_ID", ""),
    signName: envStr("SMS_SIGN_NAME", ""),
    region: envStr("SMS_REGION", "ap-guangzhou"),
    templatePass: envStr("SMS_TEMPLATE_PASS", ""),
    templateReject: envStr("SMS_TEMPLATE_REJECT", ""),
  },
  // 腾讯云 COS 对象存储(主播视频直传,绕开隧道)。密钥可单独配 COS_*,缺则回退复用短信的 SMS_SECRET_ID/KEY。
  // 配齐 bucket+region+密钥 才启用直传;否则前端自动回退隧道上传。
  cos: {
    secretId: envStr("COS_SECRET_ID", "") || envStr("SMS_SECRET_ID", ""),
    secretKey: envStr("COS_SECRET_KEY", "") || envStr("SMS_SECRET_KEY", ""),
    bucket: envStr("COS_BUCKET", ""),     // 形如 myrecruit-1250000000
    region: envStr("COS_REGION", "ap-guangzhou"),
  },
  isProd: process.env.NODE_ENV === "production",
};

export type AppConfig = typeof config;
