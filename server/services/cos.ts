// 腾讯云 COS 对象存储:生成预签名 URL,让候选人浏览器直传/回看/删除(绕开 Cloudflare 隧道)。
// 签名按 COS XML API "签名 v5"(q-sign-algorithm=sha1)。配齐 bucket+region+密钥才启用。
import { createHash, createHmac } from "node:crypto";
import https from "node:https";
import { config } from "../config.js";

export function cosConfigured(): boolean {
  const c = config.cos;
  return Boolean(c.secretId && c.secretKey && c.bucket && c.region);
}

function cosHost(): string { return `${config.cos.bucket}.cos.${config.cos.region}.myqcloud.com`; }
function sha1hex(s: string): string { return createHash("sha1").update(s, "utf8").digest("hex"); }
function hmacSha1hex(key: string, s: string): string { return createHmac("sha1", key).update(s, "utf8").digest("hex"); }

/** key 路径编码:每段 encodeURIComponent,保留 "/"。 */
function encodeKey(key: string): string {
  return "/" + key.split("/").map((s) => encodeURIComponent(s)).join("/");
}

/** 生成某 key 的预签名 URL(method=PUT 上传 / GET 回看 / DELETE 删除)。默认 1 小时有效。 */
export function cosPresignUrl(method: "PUT" | "GET" | "DELETE", key: string, expireSec = 3600): string {
  const { secretId, secretKey } = config.cos;
  const now = Math.floor(Date.now() / 1000) - 60; // 容忍时钟偏差
  const exp = now + expireSec;
  const keyTime = `${now};${exp}`;
  const signKey = hmacSha1hex(secretKey, keyTime);
  const pathname = encodeKey(key);
  // 不签名任何 header / url 参数(header-list、param-list 都为空)
  const httpString = `${method.toLowerCase()}\n${pathname}\n\n\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1hex(httpString)}\n`;
  const signature = hmacSha1hex(signKey, stringToSign);
  const qs = [
    "q-sign-algorithm=sha1",
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    "q-header-list=",
    "q-url-param-list=",
    `q-signature=${signature}`,
  ].join("&");
  return `https://${cosHost()}${pathname}?${qs}`;
}

/** 服务端直接上传一段 buffer 到 COS(转写失败时备份录音用)。成功返回 true。 */
export function cosPutObject(key: string, body: Buffer, contentType = "application/octet-stream"): Promise<boolean> {
  if (!cosConfigured()) return Promise.resolve(false);
  const url = cosPresignUrl("PUT", key, 600);
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request(
      { host: u.host, path: u.pathname + u.search, method: "PUT", headers: { "Content-Type": contentType, "Content-Length": body.length } },
      (res) => { res.on("data", () => undefined); res.on("end", () => resolve((res.statusCode || 500) < 300)); }
    );
    req.on("error", () => resolve(false));
    req.end(body);
  });
}

/** 服务端拉取 COS 对象内容(重转时取回备份录音)。失败返回 null。 */
export function cosGetObject(key: string): Promise<Buffer | null> {
  if (!cosConfigured()) return Promise.resolve(null);
  const url = cosPresignUrl("GET", key, 600);
  return new Promise((resolve) => {
    const u = new URL(url);
    https.get({ host: u.host, path: u.pathname + u.search }, (res) => {
      if ((res.statusCode || 500) >= 300) { res.resume(); return resolve(null); }
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", () => resolve(null));
  });
}

/** 删除 COS 对象(后台删视频用)。成功/对象不存在都返回 true。 */
export function cosDeleteObject(key: string): Promise<boolean> {
  if (!cosConfigured()) return Promise.resolve(false);
  const url = cosPresignUrl("DELETE", key, 600);
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({ host: u.host, path: u.pathname + u.search, method: "DELETE" }, (res) => {
      res.on("data", () => undefined);
      res.on("end", () => resolve((res.statusCode || 500) < 300 || res.statusCode === 404));
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}
