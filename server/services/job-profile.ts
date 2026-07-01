// 岗位画像 + 评分标准。多岗位:每个岗位一套带权重的 6 维评分标准。存 settings 表(key='job_profile_config'),设置页可编辑。
// 初筛/出题/评判时按候选人岗位(role)匹配对应岗位画像;匹配不到用默认岗位。
import { getSetting, setSetting } from "../db.js";

/** 一个评分维度:带权重(0-100)与 A/B/C/D 口径。 */
export interface ScoringDimension {
  key: string;
  name: string;
  weight: number;
  criteria: string;
}

/** 一个岗位:画像 + 别名(用于匹配候选人 role)+ 6 维加权评分标准 + 推进标准。 */
export interface JobPosition {
  id: string;
  role: string;
  /** 候选人 role 字段可能出现的其它写法,用于匹配 */
  aliases: string[];
  summary: string;
  dimensions: ScoringDimension[];
  advancement: string;
}

export interface JobProfileConfig {
  positions: JobPosition[];
  defaultPositionId: string;
}

const KEY = "job_profile_config";

// ── 5 个通用软性维度的 A/B/C/D 口径会按岗位定制;专业技术维度完全按岗位写。──

export const DEFAULT_CONFIG: JobProfileConfig = {
  defaultPositionId: "ai-engineer",
  positions: [
    // ───────────────────────────── 岗位 1:AI 应用工程师 ─────────────────────────────
    {
      id: "ai-engineer",
      role: "AI应用工程师",
      aliases: ["AI-Agent应用开发工程师", "AI Agent应用开发工程师", "AI Agent", "Agent应用开发", "AI应用开发工程师", "FDE", "AI应用", "AI 应用工程师"],
      summary:
        "电商业务背景,招能把真实业务流程变成可落地 AI 工具的人。核心不是会不会用模型/框架,而是:做过可演示可复盘的 AI 应用、清楚业务场景与用户、本人深度参与核心模块(RAG/Agent/前后端交付)、能把模糊需求拆成方案并讲清取舍、失败点与迭代。看重工程落地与端到端交付,而非名词堆砌。",
      dimensions: [
        { key: "tech", name: "业务落地与交付", weight: 30, criteria:
          "考察能不能把真实业务需求做成可运行、可交付的 AI Agent / 工作流(我们的业务=给企业做 Agent 落地 + 公司工作流)。**看做成了什么、本人真正负责什么、解决了什么真问题,不苛求术语或某种最佳实践,不同技术选型同样认可**。\nA:有可演示/可复盘的 AI 应用且本人深度参与核心模块,端到端交付过、解决过真实问题。\nB(默认达标):方向对、有真实项目/经历支撑,能讲清自己做的部分,即便细节或评测不全也给 B。\nC:有基础但实操/深度存疑,只说概念缺本人贡献,需追问核实。\nD:答不出代表项目 / 明显包装 / 完全跑题。" },
        { key: "creativity", name: "学习与解决新问题", weight: 10, criteria:
          "考察面对新问题/模糊需求的方案设计与举一反三。\nA:能从业务目标反推出非显而易见的方案,主动提出更优做法或巧解,有自驱做过的小工具/开源/实验。\nB:能在给定框架内完成方案,偶有自己的优化点。\nC:只会照搬教程/现成方案,换场景就卡住。\nD:无主动设计,纯执行。" },
        { key: "coordination", name: "协调性", weight: 10, criteria:
          "考察跨职能(产品/业务/客户)推进与资源协调。\nA:主动对齐上下游,需求模糊时能拉对的人把问题定义清楚,推动落地。\nB:能配合协作,但多被动响应。\nC:只埋头写代码,几乎不与他人对齐。\nD:协作有明显摩擦或回避沟通。" },
        { key: "resilience", name: "创业期抗压能力", weight: 15, criteria:
          "考察快速迭代、需求多变、资源有限下的稳定交付与心态。\nA:有在紧期限/频繁变更/小团队多线作战下按时交付的实例,讲得出怎么排优先级、扛压力。\nB:能完成有压力的任务,但主要在稳定环境,对变更适应一般。\nC:习惯按部就班,遇变更或加压易抱怨/掉链子。\nD:明显抗压不足或求稳避险,与创业期不匹配。" },
        { key: "management", name: "组织与管理能力", weight: 10, criteria:
          "考察对自己工作/小项目/小团队的组织规划。\nA:能把复杂任务拆解、排期、定里程碑并跟踪;带过人或主导过模块端到端推进。\nB:能管好自己的任务节奏,但缺统筹他人经验。\nC:依赖别人安排,自我组织弱。\nD:无规划意识,任务常失控。" },
        { key: "communication", name: "表达与传播力", weight: 25, criteria:
          "【该岗重点,因公司在筹划 AI 教学/出镜 IP】考察能不能把复杂的事讲清楚、让人听懂(为教学/出镜铺路)。\nA:表达清晰有条理,能把复杂技术讲得通俗,有出镜/教学/分享经验或潜质。\nB:基本能讲清自己做的事。\nC:表达零散、术语堆砌,需多次追问才明白。\nD:沟通明显困难。" },
      ],
      advancement:
        "综合评判、看业务匹配,别只卡标准答案:业务落地 A/B(方向对+有真实经验即 B)=推荐/可推进重点面试,不要因表述与预期不同就压低。**综合加分项(命中越多越优先):名校+相关专业、硕士及以上、项目经验丰富、表达与传播力强、出镜/IP 潜质、教学经验、徐州本地(期望/现居/上学地在徐州)**——能力相当时上调评级/优先。只有答不出代表作/明显包装/完全跑题才不推进。",
    },
    // ───────────────────────────── 岗位 2:AI 视频制作 ─────────────────────────────
    {
      id: "ai-video",
      role: "AI视频制作",
      aliases: ["视频制作", "AI视频", "AI 视频", "短视频", "视频剪辑", "剪辑", "内容制作", "AIGC视频"],
      summary:
        "电商内容团队,招能用 AI 工具高效产出有传播力短视频/口播/带货素材的人。核心是内容创意 + 制作工艺 + 量产稳定性:懂脚本/分镜/节奏/审美,熟练用 AI 生成与剪辑工具(文生视频/数字人/AI 配音/AIGC 图)提效,能围绕电商商品(如耳机/音频)产出能转化的内容,并在量产压力下稳定出片。",
      dimensions: [
        { key: "tech", name: "专业技术", weight: 22, criteria:
          "考察视频制作工艺 + AI 工具熟练度(剪辑/调色/字幕/节奏 + 文生视频/数字人/AI 配音/AIGC 图/口型对齐等)。\nA:有成体系作品集,讲得清脚本→分镜→拍摄或生成→剪辑→成片全流程;熟练组合多种 AI 工具提效并说得出各自适用边界与坑。\nB:会剪辑、会用部分 AI 工具,作品完整但工艺或工具深度一般。\nC:只会套模板/简单剪辑,AI 工具停留在试过层面。\nD:无可展示作品或工艺明显粗糙。" },
        { key: "creativity", name: "创造力", weight: 33, criteria:
          "【该岗最重维度】考察创意点子、审美、对爆款逻辑与平台调性的理解。\nA:作品有明显创意与审美,讲得清选题/钩子/节奏/情绪设计;有数据验证的爆款或显著增长案例;能针对商品快速想出多个差异化内容角度。\nB:作品合格、审美在线,但偏模仿,缺独到创意或爆款方法论。\nC:内容平庸套路化,说不清为什么这么做。\nD:审美/创意明显不足。" },
        { key: "coordination", name: "协调性", weight: 10, criteria:
          "考察与运营/主播/商品/投放团队配合产出。\nA:主动对接运营选品与投放需求,按转化目标调整内容,协同顺畅。\nB:能配合,但多被动接需求。\nC:只按个人喜好出片,不对齐业务。\nD:协作有摩擦。" },
        { key: "resilience", name: "创业期抗压能力", weight: 15, criteria:
          "考察量产节奏、频繁改稿、追热点时效下的稳定产出。\nA:有高频出片(日更/批量)经历,多轮改稿仍稳定交付,讲得出如何保质保量。\nB:能完成有期限的产出,但量大或多改时易吃力。\nC:习惯慢工细活,赶量或改稿易崩。\nD:抗压明显不足。" },
        { key: "management", name: "组织与管理能力", weight: 8, criteria:
          "考察素材/项目/排期的组织管理。\nA:有清晰的素材管理与出片排期,能统筹多条内容线或带小制作团队。\nB:能管好自己的产出节奏。\nC:素材凌乱、靠临时赶。\nD:无组织,常误期。" },
        { key: "communication", name: "语言表达与理解(团队协作)", weight: 12, criteria:
          "考察理解需求/脚本沟通/反馈吸收。\nA:能准确理解运营与商品卖点并转成脚本;沟通顺畅,反馈吸收快。\nB:基本能沟通,偶有理解偏差。\nC:常误解需求,反复返工。\nD:沟通困难。" },
      ],
      advancement:
        "创造力 A/B 且有作品/数据支撑=推荐;创造力 B、工艺扎实=可继续;创造力 C 仅会工具=备选并要作品集追问;无作品或创造力 D=不推进。",
    },
    // ───────────────────────────── 岗位 3:电商带货主播 ─────────────────────────────
    {
      id: "live-host",
      role: "电商带货主播",
      aliases: ["带货主播", "主播", "直播带货", "电商主播", "消费电子主播", "带货", "直播主播"],
      summary:
        "电商直播带货主播。核心是镜头表现力 + 表达感染力 + 长时直播抗压 + 产品理解与转化:能把消费电子/标准化商品卖点讲得专业又有感染力,临场应变控场,长时间直播稳定输出,配合中控/运营完成转化目标。看重口才、临场、抗压与对产品的理解。",
      dimensions: [
        { key: "tech", name: "专业技术", weight: 18, criteria:
          "考察直播带货专业度 + 产品理解(话术结构/逼单转化技巧/对目标品类卖点的掌握/直播工具与数据)。\nA:有带货数据(GMV/转化/场观)佐证,讲得清话术结构与逼单节奏,对所售品类有专业理解,能把参数翻译成用户能感知的卖点。\nB:有直播经验、话术成型,但数据一般或对本品类理解偏浅。\nC:只播过但说不清方法,产品全靠背稿。\nD:无直播带货经验或明显不懂产品。" },
        { key: "creativity", name: "创造力", weight: 12, criteria:
          "考察直播互动玩法、内容设计、差异化人设。\nA:能设计有记忆点的互动/玩法/话术,有独特主播人设。\nB:能跟成熟玩法走,偶有自己花样。\nC:照本宣科,无互动设计。\nD:无创意,枯燥。" },
        { key: "coordination", name: "协调性", weight: 12, criteria:
          "考察与中控/场控/运营/投流的实时配合。\nA:能与中控憋单、上下链接、应对流量节奏紧密配合,主动对齐场次目标。\nB:能配合,但临场配合偶有脱节。\nC:各播各的,不看场内信号。\nD:配合差,影响转化。" },
        { key: "resilience", name: "创业期抗压能力", weight: 23, criteria:
          "【该岗最重维度之一】考察长时间直播、实时数据波动、冷场/黑粉/卡顿等突发下的稳定与情绪管理。\nA:有长时段(数小时)高频开播经历,面对冷场/数据差/突发能稳住情绪、调整节奏继续输出,讲得出怎么扛压力。\nB:能完成常规时长直播,但遇明显冷场或数据压力会受影响。\nC:时长或抗压有限,易被场内情况带崩。\nD:明显扛不住直播强度。" },
        { key: "management", name: "组织与管理能力", weight: 8, criteria:
          "考察直播节奏/脚本/场次的自我组织。\nA:能规划场次脚本、品的节奏与时间分配,自我管理强。\nB:能跟既定流程走。\nC:依赖他人安排,自我组织弱。\nD:无节奏,场面失控。" },
        { key: "communication", name: "语言表达与理解(团队协作)", weight: 27, criteria:
          "【该岗最重维度】考察口才、表达感染力、临场反应、对话术与卖点的理解转化。\nA:口齿清晰、表达有感染力和节奏感,镜头感强,临场反应快,能把专业卖点讲得通俗打动人;准确理解运营意图。\nB:表达流畅,但感染力或临场反应一般。\nC:表达平淡或紧张卡顿,镜头感弱。\nD:表达明显吃力,不适合出镜。" },
      ],
      advancement:
        "表达与抗压 A/B 且有带货数据=推荐试播;表达好但数据浅=可试播观察;表达 C=不推进出镜岗;无相关经验或多项 D=不推进。",
    },
    // ───────────────────────────── 岗位 4:AI 产品经理 ─────────────────────────────
    {
      id: "ai-pm",
      role: "AI产品经理",
      aliases: ["AI产品经理", "AI产品", "产品经理", "AI PM", "AIPM", "产品经理(AI)", "AI 产品经理", "AI产品负责人"],
      summary:
        "AI 产品经理。核心是:对 AI 产品有深入理解,能调研市场/分析竞品、独立做产品设计与规划(整体流程、交互、PRD/产品说明书),并有成熟项目经验与实际成绩(大厂背景加分)。看重对 AI 能力边界与落地场景的判断、把模糊需求变成清晰产品方案的能力,以及真实做过、跑出过结果。",
      dimensions: [
        { key: "ai_knowledge", name: "AI 产品专业知识", weight: 22, criteria:
          "考察对 AI 产品的理解深度:大模型/Agent/RAG 等能力与边界、典型 AI 产品形态与落地场景、对体验与技术取舍的判断。\nA:对 AI 产品有体系化深入理解,能讲清能力边界、适用场景与取舍,对前沿有自己的判断。\nB(默认达标):理解到位、能讲清主流 AI 产品逻辑,细节略浅也给 B。\nC:概念零散、停留在使用层面,缺判断。\nD:基本不懂 AI 产品。" },
        { key: "research", name: "市场调研与视野", weight: 18, criteria:
          "考察行业视野与调研能力:能持续调研市场上的 AI 产品、了解竞品与趋势、开拓视野找机会。\nA:主动持续调研,讲得出多款 AI 产品的差异、趋势与机会判断,视野开阔。\nB:了解主流竞品与趋势,能做基本调研。\nC:只知道少数产品,缺主动调研。\nD:几乎不了解市场。" },
        { key: "product_design", name: "产品设计与规划", weight: 28, criteria:
          "【该岗最重维度】考察竞品分析 + 产品设计落地:能分析竞品特点;能负责产品设计(整体流程、交互设计、写 PRD/产品说明书);把模糊需求拆成清晰方案与规划。\nA:有完整的竞品分析方法,独立做过产品从 0-1 设计(流程/交互/文档齐全),需求拆解与规划清晰,有可展示的产品/原型/文档。\nB:参与过产品设计、能做竞品分析与基本 PRD,主导程度一般。\nC:只做过执行性工作(画图/写局部文档),缺整体设计与规划。\nD:无产品设计经验。" },
        { key: "experience", name: "项目经验与成绩", weight: 22, criteria:
          "考察项目经验的成熟度与实际成绩:大厂工作经验(加分)、负责过成熟的产品/项目、取得过可量化的实际成绩(用户量/收入/效率/上线效果等)。\nA:有大厂或成熟团队经验,主导过完整产品/项目并拿到可量化成绩。\nB:有真实项目经验、参与过完整周期,成绩一般或偏参与。\nC:经验偏浅、多为小项目或边缘参与,无明确成绩。\nD:无拿得出手的项目经验。" },
        { key: "communication", name: "沟通协作与表达", weight: 10, criteria:
          "考察跨团队(研发/设计/运营/老板)沟通推进与表达:能把产品方案讲清楚、对齐各方、推动落地。\nA:表达清晰有逻辑,能对齐多方、推动跨团队落地,文档/讲述都到位。\nB:基本能沟通表达,推进多靠配合。\nC:表达零散,跨团队推进吃力。\nD:沟通明显困难。" },
      ],
      advancement:
        "产品设计与规划 A/B + 有成熟项目经验=推荐重点面试。**加分项(命中越多越优先):大厂背景、对 AI 产品理解深、有可展示的竞品分析/PRD/产品成果、可量化成绩、名校/高学历**。只做执行性工作、无整体设计与项目成绩、或对 AI 产品理解很浅=不推进。",
    },
  ],
};

/** 把字符串归一化用于匹配(去空格/横杠/括号,转小写)。 */
function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[\s\-_/()（）·、,，]+/g, "");
}

export function getConfig(): JobProfileConfig {
  const cfg = getSetting<JobProfileConfig>(KEY, DEFAULT_CONFIG);
  if (!cfg || !Array.isArray(cfg.positions) || cfg.positions.length === 0) return DEFAULT_CONFIG;
  return cfg;
}

export function saveConfig(config: JobProfileConfig): JobProfileConfig {
  const current = getConfig();
  const positions = Array.isArray(config.positions) && config.positions.length ? config.positions : current.positions;
  const next: JobProfileConfig = {
    positions: positions.map((p) => ({
      id: String(p.id || "").trim() || `pos-${norm(p.role).slice(0, 12) || "x"}`,
      role: String(p.role || ""),
      aliases: Array.isArray(p.aliases) ? p.aliases.map(String) : [],
      summary: String(p.summary || ""),
      dimensions: Array.isArray(p.dimensions)
        ? p.dimensions.map((d) => ({
            key: String(d.key || ""),
            name: String(d.name || ""),
            weight: Number.isFinite(Number(d.weight)) ? Math.max(0, Math.round(Number(d.weight))) : 0,
            criteria: String(d.criteria || ""),
          }))
        : [],
      advancement: String(p.advancement || ""),
    })),
    defaultPositionId:
      config.defaultPositionId && positions.some((p) => p.id === config.defaultPositionId)
        ? config.defaultPositionId
        : positions[0]?.id || "",
  };
  setSetting(KEY, next);
  return next;
}

/** 按候选人岗位(role)匹配岗位画像;匹配不到返回默认岗位。可传入已加载的 cfg 避免逐行重复读配置。 */
export function getPositionForRole(role?: string, cfg: JobProfileConfig = getConfig()): JobPosition {
  const fallback = cfg.positions.find((p) => p.id === cfg.defaultPositionId) || cfg.positions[0];
  const r = norm(role || "");
  if (!r) return fallback;
  for (const p of cfg.positions) {
    const keys = [p.role, ...(p.aliases || [])].map(norm).filter(Boolean);
    if (keys.some((k) => r.includes(k) || k.includes(r))) return p;
  }
  return fallback;
}

/** 该候选人岗位是否为「AI 视频制作」类(决定是否开放作品集上传)。
 *  以匹配到的岗位 id='ai-video' 为准;同时兜底匹配 role/别名里含「视频」。 */
export function isVideoCreatorRole(role?: string): boolean {
  const p = getPositionForRole(role);
  if (p.id === "ai-video") return true;
  const hay = norm([p.role, ...(p.aliases || []), role || ""].join(""));
  return hay.includes("视频");
}

/** 把一个岗位画像渲染成给大模型的文本上下文(含权重)。 */
export function renderJobProfileForPrompt(position: JobPosition = getPositionForRole()): string {
  const total = position.dimensions.reduce((s, d) => s + (d.weight || 0), 0) || 1;
  const dims = position.dimensions
    .map((d, i) => `${i + 1}. 【${d.name}】(权重 ${d.weight}% / 共 ${total}%)\n${d.criteria}`)
    .join("\n\n");
  return `岗位:${position.role}\n岗位画像:${position.summary}\n\n评分维度(每维给 A/B/C/D,并按权重折算加权总分):\n${dims}\n\n推进标准:${position.advancement}`;
}
