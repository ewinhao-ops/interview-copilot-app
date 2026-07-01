// AI 文本模型配置 + chat 代理。配置存 settings 表(key='ai_runtime_config'),
// 密钥由服务端持有,不再下发前端。
// 注:实时 ASR(qwen-omni/iflytek)相关字段在阶段2 异步化后将删除,这里暂保留以兼容旧设置页。
import { getSetting, setSetting } from "./db.js";

export type AiProvider = "mimo" | "deepseek" | "deepseek-flash";
export type AiUsageScene =
  | "questionGeneration" | "questionAdjustment" | "followUpGeneration"
  | "transcriptCorrection" | "evaluationReport" | "screening";

const SETTINGS_KEY = "ai_runtime_config";

export interface AiRuntimeConfig {
  sceneProviders: Record<AiUsageScene, AiProvider>;
  // 批量转写(阶段2)用 DashScope
  dashScopeApiKey: string;
  dashScopeAsrModel: string;
  mimoApiKey: string;
  mimoBaseUrl: string;
  mimoModel: string;
  deepSeekApiKey: string;
  deepSeekBaseUrl: string;
  deepSeekModel: string;
  deepSeekFlashModel: string;
}

function coerceProvider(value: unknown, fallback: AiProvider): AiProvider {
  return value === "mimo" || value === "deepseek" || value === "deepseek-flash" ? value : fallback;
}
function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function defaults(): AiRuntimeConfig {
  const dsKey = process.env.DEEPSEEK_API_KEY || "";
  const defaultText: AiProvider = dsKey ? "deepseek" : "mimo";
  return {
    sceneProviders: {
      questionGeneration: defaultText,
      questionAdjustment: defaultText,
      followUpGeneration: defaultText,
      transcriptCorrection: dsKey ? "deepseek-flash" : "mimo",
      evaluationReport: defaultText,
      screening: defaultText,
    },
    dashScopeApiKey: process.env.DASHSCOPE_API_KEY || "",
    dashScopeAsrModel: process.env.DASHSCOPE_ASR_MODEL || "paraformer-v2",
    mimoApiKey: process.env.MIMO_API_KEY || "",
    mimoBaseUrl: process.env.MIMO_BASE_URL || "https://token-plan-cn.xiaomimimo.com/v1",
    mimoModel: process.env.MIMO_MODEL || "mimo-v2.5-pro",
    deepSeekApiKey: dsKey,
    deepSeekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
    deepSeekModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    deepSeekFlashModel: process.env.DEEPSEEK_FLASH_MODEL || "deepseek-v4-flash",
  };
}

export function readAiConfig(): AiRuntimeConfig {
  const base = defaults();
  const saved = getSetting<Partial<AiRuntimeConfig>>(SETTINGS_KEY, {});
  return sanitizeAiConfig({ ...base, ...saved, sceneProviders: { ...base.sceneProviders, ...(saved.sceneProviders || {}) } }, base);
}

export function sanitizeAiConfig(value: Partial<AiRuntimeConfig>, current = readAiConfig()): AiRuntimeConfig {
  const sp = (value.sceneProviders || {}) as Partial<Record<AiUsageScene, unknown>>;
  return {
    sceneProviders: {
      questionGeneration: coerceProvider(sp.questionGeneration, current.sceneProviders.questionGeneration),
      questionAdjustment: coerceProvider(sp.questionAdjustment, current.sceneProviders.questionAdjustment),
      followUpGeneration: coerceProvider(sp.followUpGeneration, current.sceneProviders.followUpGeneration),
      transcriptCorrection: coerceProvider(sp.transcriptCorrection, current.sceneProviders.transcriptCorrection),
      evaluationReport: coerceProvider(sp.evaluationReport, current.sceneProviders.evaluationReport),
      screening: coerceProvider(sp.screening, current.sceneProviders.screening),
    },
    dashScopeApiKey: str(value.dashScopeApiKey, current.dashScopeApiKey),
    dashScopeAsrModel: str(value.dashScopeAsrModel, current.dashScopeAsrModel),
    mimoApiKey: str(value.mimoApiKey, current.mimoApiKey),
    mimoBaseUrl: str(value.mimoBaseUrl, current.mimoBaseUrl),
    mimoModel: str(value.mimoModel, current.mimoModel),
    deepSeekApiKey: str(value.deepSeekApiKey, current.deepSeekApiKey),
    deepSeekBaseUrl: str(value.deepSeekBaseUrl, current.deepSeekBaseUrl),
    deepSeekModel: str(value.deepSeekModel, current.deepSeekModel),
    deepSeekFlashModel: str(value.deepSeekFlashModel, current.deepSeekFlashModel),
  };
}

export function writeAiConfig(value: Partial<AiRuntimeConfig>): AiRuntimeConfig {
  const next = sanitizeAiConfig(value);
  setSetting(SETTINGS_KEY, next);
  return next;
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/** 给前端的脱敏配置(密钥只回掩码) */
export function maskedAiConfig(): AiRuntimeConfig & Record<string, unknown> {
  const c = readAiConfig();
  return {
    ...c,
    dashScopeApiKey: maskSecret(c.dashScopeApiKey),
    mimoApiKey: maskSecret(c.mimoApiKey),
    deepSeekApiKey: maskSecret(c.deepSeekApiKey),
  };
}

interface TextModel { provider: AiProvider; apiKey: string; baseUrl: string; model: string; }

export function resolveTextModel(scene: AiUsageScene): TextModel {
  const c = readAiConfig();
  const provider = c.sceneProviders[scene] || "mimo";
  if (provider === "deepseek" || provider === "deepseek-flash") {
    return {
      provider,
      apiKey: c.deepSeekApiKey,
      baseUrl: c.deepSeekBaseUrl,
      model: provider === "deepseek-flash" ? c.deepSeekFlashModel : c.deepSeekModel,
    };
  }
  return { provider, apiKey: c.mimoApiKey, baseUrl: c.mimoBaseUrl, model: c.mimoModel };
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface ChatMessage { role: string; content: string; }

/** 统一的大模型 chat 调用(OpenAI 兼容)。 */
// 单次 AI 文本生成,可设超时;失败(网络/超时/5xx/限流/空返回)由 chat() 负责重试。
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 60000;
const AI_RETRIES = Number.isFinite(Number(process.env.AI_RETRIES)) ? Number(process.env.AI_RETRIES) : 1;

export async function chat(opts: {
  scene: AiUsageScene;
  messages: ChatMessage[];
  temperature?: number;
  model?: string;
}): Promise<string> {
  const cfg = resolveTextModel(opts.scene);
  if (!cfg.apiKey) throw new Error(`${cfg.provider} API key 未配置`);
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);
  const model = opts.model || cfg.model || "mimo-v2.5-pro";

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= AI_RETRIES; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
          ...(cfg.provider === "mimo" ? { "api-key": cfg.apiKey } : {}),
        },
        body: JSON.stringify({
          model,
          messages: opts.messages,
          temperature: typeof opts.temperature === "number" ? opts.temperature : 0.25,
        }),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${cfg.provider} 请求失败 ${response.status}: ${errorText.slice(0, 240)}`);
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string }; text?: string }>;
        output_text?: string; text?: string;
      };
      const text = payload.choices?.[0]?.message?.content || payload.choices?.[0]?.text || payload.output_text || payload.text || "";
      if (!text.trim()) throw new Error(`${cfg.provider} 返回为空`);
      return text.trim();
    } catch (e: any) {
      lastErr = e?.name === "TimeoutError" || e?.name === "AbortError"
        ? new Error(`${cfg.provider} 请求超时(${AI_TIMEOUT_MS / 1000}s)`)
        : (e instanceof Error ? e : new Error(String(e)));
      if (attempt < AI_RETRIES) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr || new Error(`${cfg.provider} 请求失败`);
}
