// 每日 AI 初筛:对照岗位画像评估新简历 -> 评级 + 理由(引用简历原文) + 风险 + 预生成定制面试题。
import { chat } from "../ai.js";
import { renderJobProfileForPrompt, getPositionForRole, type JobPosition } from "./job-profile.js";
import { extractJson } from "./interview-ai.js";
import { extractEducation, detectTeachingIp, backgroundSignalForPrompt } from "./education.js";
import { detectXuzhouLocal } from "./location.js";

export interface ScreeningResult {
  rating: "推荐" | "待定" | "不推荐";
  summary: string; // 一句话结论
  reasons: Array<{ point: string; quote: string }>;
  risks: string[];
  generatedQuestions: Array<{ questionId: string; dimension: string; question: string }>;
  positionId: string; // 本次初筛匹配到的岗位 id
}

const RATINGS = new Set(["推荐", "待定", "不推荐"]);

export async function screenCandidate(opts: {
  name: string;
  role?: string;
  resumeText: string;
}): Promise<ScreeningResult> {
  const position = getPositionForRole(opts.role);
  const resume = (opts.resumeText || "").trim();
  if (!resume) {
    return { rating: "不推荐", summary: "简历文本为空,无法评估。", reasons: [], risks: ["简历文本为空,无法评估"], generatedQuestions: [], positionId: position.id };
  }
  const dims = position.dimensions.map((d) => d.name).join("、");
  const edu = extractEducation(resume);
  const bgSignal = backgroundSignalForPrompt(edu, detectXuzhouLocal(resume), detectTeachingIp(resume));
  // 综合加分(各岗位通用):看匹配与潜力,别只卡硬框架
  const eduBonusRule = "\n- 综合加分项(命中越多越好,能力相当时上调评级/优先):名校 + 相关专业、硕士及以上、项目经验丰富、表达与传播力强、出镜/IP 潜质、教学经验、**徐州本地(期望/现居/上学地在徐州,我们优先)**。加分项不能替代实际业务落地能力,但不要因为表述/背景普通就过度压低有真实经验者。";
  const system = `你是资深招聘官,按下面这个岗位的画像与评分标准对简历做初筛。
${renderJobProfileForPrompt(position)}

输出严格 JSON:
{
 "rating": "推荐|待定|不推荐",
 "summary": "一句话结论(40 字以内,高度概括是否值得面试及最关键原因)",
 "reasons": [{"point":"判断要点","quote":"简历中支撑这个判断的原文片段(逐字摘录,不得编造)"}],
 "risks": ["风险/存疑点", ...],
 "generatedQuestions": [{"questionId":"q1","dimension":"维度名","question":"针对这位候选人简历定制的异步面试题"}]
}
要求:
- summary 必须是一句话,不超过 40 字,直接给结论,不要展开。
- rating 严格按上面的推进标准与加权维度判断,看重权重高的维度。
- reasons 的 quote 必须是简历里的原话,用来让人核对。
- generatedQuestions 生成 4-6 道,覆盖维度(${dims}),每道都要结合**这份简历提到的具体项目/经历**,不要泛泛通用题。${eduBonusRule}`;
  const user = `候选人:${opts.name}${opts.role ? `(${opts.role})` : ""}\n${bgSignal ? bgSignal + "\n" : ""}\n简历:\n${resume}`;
  const raw = await chat({ scene: "screening", messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.3 });
  const parsed = extractJson<ScreeningResult>(raw);
  if (!parsed) {
    return { rating: "待定", summary: raw.slice(0, 40), reasons: [], risks: ["AI 初筛解析失败,需人工复核"], generatedQuestions: [], positionId: position.id };
  }
  const rating = RATINGS.has(String(parsed.rating)) ? parsed.rating : "待定";
  return {
    positionId: position.id,
    rating: rating as ScreeningResult["rating"],
    summary: String(parsed.summary ?? ""),
    reasons: Array.isArray(parsed.reasons)
      ? parsed.reasons.map((r: any) => ({ point: String(r?.point ?? ""), quote: String(r?.quote ?? "") })).filter((r) => r.point)
      : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
    generatedQuestions: Array.isArray(parsed.generatedQuestions)
      ? parsed.generatedQuestions.map((q: any, i: number) => ({
          questionId: String(q?.questionId ?? `q${i + 1}`),
          dimension: String(q?.dimension ?? ""),
          question: String(q?.question ?? ""),
        })).filter((q) => q.question)
      : [],
  };
}

// ─────────────── 发起面试时按"配额"定制出题 ───────────────
// 后台发起 AI 面试前在弹窗里指定:总题数 + 各维度(尤其专业技术)各出几道,
// 据此让大模型严格按配额、结合本人简历定制题目。

export interface QuestionSpecItem { dimension: string; count: number; }
export interface GeneratedQuestion { questionId: string; dimension: string; question: string; }

/** 按维度权重把总题数拆成各维度配额(最大余额法分配,合计严格等于 total)。 */
export function suggestQuestionCounts(
  position: JobPosition,
  total: number,
): Array<{ key: string; name: string; weight: number; n: number }> {
  const dims = position.dimensions;
  const t = Math.max(0, Math.round(total || 0));
  const totalW = dims.reduce((s, d) => s + (d.weight || 0), 0) || 1;
  const rows = dims.map((d) => {
    const exact = (t * (d.weight || 0)) / totalW;
    return { key: d.key, name: d.name, weight: d.weight || 0, n: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let assigned = rows.reduce((s, r) => s + r.n, 0);
  const order = [...rows].sort((a, b) => b.frac - a.frac || b.weight - a.weight);
  let i = 0;
  while (assigned < t && order.length) { order[i % order.length].n++; assigned++; i++; }
  return rows.map(({ key, name, weight, n }) => ({ key, name, weight, n }));
}

// 限并发并行执行,保持结果与输入同序。维度数少时几乎全并行,避免一次性打太多 AI 请求被限流。
async function runWithConcurrency<T, R>(items: T[], fn: (item: T) => Promise<R>, limit: number): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await fn(items[cur]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

const QGEN_CONCURRENCY = Number(process.env.QGEN_CONCURRENCY) || 5;

/** 按指定配额(各维度题数)结合简历定制面试题。各维度**并行**各发一次模型调用,
 *  墙钟≈最慢的单维度(而非各维度串行求和),显著加快多题出题;单维度失败只影响该维度,其余照常返回。 */
export async function generateInterviewQuestions(opts: {
  name: string;
  role?: string;
  resumeText: string;
  spec: QuestionSpecItem[];
}): Promise<GeneratedQuestion[]> {
  const position = getPositionForRole(opts.role);
  const resume = (opts.resumeText || "").trim();
  const wanted = (opts.spec || []).filter((s) => s && s.dimension && s.count > 0);
  const total = wanted.reduce((s, x) => s + Math.round(x.count), 0);
  if (!resume || total <= 0) return [];

  const dimByName = new Map(position.dimensions.map((d) => [d.name, d]));
  const profile = renderJobProfileForPrompt(position);
  const userMsg = `候选人:${opts.name}${opts.role ? `(${opts.role})` : ""}\n\n简历:\n${resume}`;

  // 为单个维度出题(chat 自带超时+重试;此处再兜底捕获,失败返回空,不拖累其它维度)
  async function genForDim(s: QuestionSpecItem): Promise<GeneratedQuestion[]> {
    const n = Math.round(s.count);
    const d = dimByName.get(s.dimension);
    const isTech = s.dimension.includes("技术") || d?.key === "tech";
    const hint = d ? `本维度考察点:${(d.criteria || "").split("\n").slice(0, 4).join(" ")}` : "";
    const system = `你是「${position.role}」岗位面试官,为这位候选人定制异步(录音口述)面试题。
${profile}

本次只为【${s.dimension}】这一个维度出题,数量必须恰好 ${n} 道。
${hint}

要求:
- 每道题必须结合**这份简历里提到的具体项目/经历/数字**,针对本人提问,不要泛泛的通用题。
- 题目要能在「${s.dimension}」维度上区分候选人深浅;适合异步口述回答(不要写代码题/白板题)。
${isTech ? "- 技术性问题要能戳到工程/业务落地细节。" : "- 紧扣本维度考察点提问。"}
- 严格输出 JSON,questions 数组恰好 ${n} 条:
{"questions":[{"question":"题面"}]}`;
    try {
      const raw = await chat({ scene: "screening", messages: [{ role: "system", content: system }, { role: "user", content: userMsg }], temperature: 0.4 });
      const parsed = extractJson<{ questions: any[] }>(raw);
      const arr = Array.isArray(parsed?.questions) ? parsed!.questions : [];
      return arr
        .map((q: any) => String(q?.question ?? (typeof q === "string" ? q : "")).trim())
        .filter(Boolean)
        .slice(0, n)
        .map((question) => ({ questionId: "", dimension: s.dimension, question }));
    } catch (e) {
      console.error(`[generateInterviewQuestions] 维度「${s.dimension}」出题失败:`, (e as Error).message);
      return [];
    }
  }

  const results = await runWithConcurrency(wanted, genForDim, QGEN_CONCURRENCY);
  // 按维度顺序合并,统一重编 questionId
  return results.flat().map((q, i) => ({ ...q, questionId: `q${i + 1}` }));
}
