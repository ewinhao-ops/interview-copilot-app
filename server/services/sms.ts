// 腾讯云短信(SendSms,API v3 TC3-HMAC-SHA256 签名,不依赖 SDK)。
// 配置全部齐全(.env: SMS_SECRET_ID/SECRET_KEY/SDK_APP_ID/SIGN_NAME/TEMPLATE_*)才会真正发送;否则 isConfigured()=false,调用方跳过。
import { createHash, createHmac } from "node:crypto";
import https from "node:https";
import { config } from "../config.js";

const HOST = "sms.tencentcloudapi.com";
const SERVICE = "sms";
const VERSION = "2021-01-11";
const ACTION = "SendSms";

export function smsConfigured(): boolean {
  const s = config.sms;
  return Boolean(s.secretId && s.secretKey && s.sdkAppId && s.signName);
}

function sha256hex(s: string): string { return createHash("sha256").update(s, "utf8").digest("hex"); }
function hmac(key: Buffer | string, s: string): Buffer { return createHmac("sha256", key).update(s, "utf8").digest(); }

/** 发一条短信。phone 为 11 位手机号;templateId 模板 ID;params 模板变量数组。成功返回 {ok:true}。 */
export async function sendSms(phone: string, templateId: string, params: string[]): Promise<{ ok: boolean; error?: string }> {
  if (!smsConfigured() || !templateId) return { ok: false, error: "sms_not_configured" };
  const p = (phone || "").replace(/\D/g, "");
  if (!/^1[3-9]\d{9}$/.test(p)) return { ok: false, error: "bad_phone" };

  const { secretId, secretKey, sdkAppId, signName, region } = config.sms;
  const payload = JSON.stringify({
    PhoneNumberSet: [`+86${p}`],
    SmsSdkAppId: sdkAppId,
    SignName: signName,
    TemplateId: templateId,
    TemplateParamSet: params.map(String),
  });

  // 腾讯云用整型秒级时间戳;脚本环境禁用了 Date.now(),用 process env 注入的时间或退回 Date(运行期 Node 允许)
  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);

  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${HOST}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sha256hex(payload)].join("\n");
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = ["TC3-HMAC-SHA256", String(ts), credentialScope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac(`TC3${secretKey}`, date);
  const kService = hmac(kDate, SERVICE);
  const kSigning = hmac(kService, "tc3_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return new Promise((resolve) => {
    const req = https.request(
      { host: HOST, method: "POST", path: "/", headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: authorization,
        "X-TC-Action": ACTION,
        "X-TC-Version": VERSION,
        "X-TC-Timestamp": String(ts),
        "X-TC-Region": region,
        Host: HOST,
      } },
      (res) => {
        const ch: Buffer[] = [];
        res.on("data", (d) => ch.push(d));
        res.on("end", () => {
          try {
            const j = JSON.parse(Buffer.concat(ch).toString());
            const r = j?.Response;
            const status = r?.SendStatusSet?.[0];
            if (r?.Error) return resolve({ ok: false, error: r.Error.Code + ":" + r.Error.Message });
            if (status && status.Code !== "Ok") return resolve({ ok: false, error: status.Code + ":" + status.Message });
            resolve({ ok: true });
          } catch (e) { resolve({ ok: false, error: "parse_error" }); }
        });
      }
    );
    req.on("error", (e) => resolve({ ok: false, error: String(e?.message || e) }));
    req.write(payload);
    req.end();
  });
}

/** 发结果通知短信(通过/不通过)。模板变量约定:{1}=岗位名(可按你审核的模板调整)。 */
export async function sendResultSms(phone: string, result: "pass" | "reject", role: string): Promise<{ ok: boolean; error?: string }> {
  const tpl = result === "pass" ? config.sms.templatePass : config.sms.templateReject;
  if (!tpl) return { ok: false, error: "template_missing" };
  return sendSms(phone, tpl, [role || "应聘"]);
}
