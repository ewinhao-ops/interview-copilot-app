// 从简历文本里规则化抽取「毕业院校层次(985/211/双一流)」与「最高学历(博士/硕士/本科/大专)」。
// 全量候选人都能打标(不依赖 AI 初筛),供后台人才库标注 + 筛选;AI 初筛也会把它作为加分信号注入提示词。
// 这是「提示性」标注:边角情况(独立学院、海外同名、简历里提到他人学历)可能有偏差,后台可点开简历复核。

export type SchoolTier = "985" | "211" | "双一流" | "";
export type Degree = "博士" | "硕士" | "本科" | "大专" | "";

export interface Education {
  schoolTier: SchoolTier;
  schoolName: string; // 命中的院校名(便于核对)
  degree: Degree;
  postgrad: boolean; // 硕士及以上
}

// ── 985(39 所,完整) ──
const SCHOOLS_985 = [
  "清华大学", "北京大学", "中国人民大学", "北京航空航天大学", "北京理工大学", "中国农业大学", "北京师范大学", "中央民族大学",
  "南开大学", "天津大学", "大连理工大学", "东北大学", "吉林大学", "哈尔滨工业大学", "复旦大学", "同济大学", "上海交通大学",
  "华东师范大学", "南京大学", "东南大学", "浙江大学", "中国科学技术大学", "厦门大学", "山东大学", "中国海洋大学", "武汉大学",
  "华中科技大学", "湖南大学", "中南大学", "中山大学", "华南理工大学", "四川大学", "重庆大学", "电子科技大学", "西安交通大学",
  "西北工业大学", "西北农林科技大学", "兰州大学", "国防科技大学", "国防科学技术大学",
];

// ── 211(985 之外的部分;尽量覆盖)──
const SCHOOLS_211 = [
  "北京交通大学", "北京工业大学", "北京科技大学", "北京化工大学", "北京邮电大学", "北京林业大学", "北京中医药大学",
  "北京外国语大学", "中国传媒大学", "中央财经大学", "对外经济贸易大学", "北京体育大学", "中央音乐学院", "中国政法大学",
  "华北电力大学", "中国矿业大学", "中国石油大学", "中国地质大学", "北京协和医学院",
  "天津医科大学", "河北工业大学", "太原理工大学", "内蒙古大学", "辽宁大学", "大连海事大学",
  "延边大学", "东北师范大学", "哈尔滨工程大学", "东北农业大学", "东北林业大学",
  "华东理工大学", "东华大学", "上海大学", "上海财经大学", "上海外国语大学", "海军军医大学", "第二军医大学",
  "苏州大学", "南京航空航天大学", "南京理工大学", "河海大学", "江南大学", "南京农业大学", "中国药科大学", "南京师范大学",
  "安徽大学", "合肥工业大学", "福州大学", "南昌大学", "郑州大学",
  "武汉理工大学", "华中农业大学", "华中师范大学", "中南财经政法大学", "湖南师范大学",
  "暨南大学", "华南师范大学", "广西大学", "海南大学", "西南大学", "四川农业大学", "西南交通大学", "西南财经大学",
  "贵州大学", "云南大学", "西藏大学", "西安电子科技大学", "长安大学", "陕西师范大学", "西北大学", "空军军医大学", "第四军医大学",
  "青海大学", "宁夏大学", "新疆大学", "石河子大学",
];

// ── 双一流(非 211 中较知名的补充;软信号)──
const SCHOOLS_SHUANGYILIU_EXTRA = [
  "南方科技大学", "上海科技大学", "中国科学院大学", "宁波大学", "河南大学", "湘潭大学", "首都师范大学",
  "南京邮电大学", "南京信息工程大学", "南京林业大学", "华南农业大学", "广州医科大学", "成都理工大学", "西南石油大学",
  "成都中医药大学", "天津工业大学", "上海中医药大学", "上海海洋大学", "中国美术学院", "中央美术学院", "中央戏剧学院",
  "中国音乐学院", "外交学院", "中国人民公安大学", "山西大学", "福建师范大学", "湖南农业大学", "广州中医药大学", "天津中医药大学",
];

// ── 独立学院 / 校名里嵌了名校但本身不是该校:抽取前先剔除,避免把"电子科技大学成都学院"误判成 985/211。
// 名单同时保留改名前后的旧名(沿用旧名写简历的最易误判)。最长名优先剔除。──
const INDEPENDENT_COLLEGES = [
  "电子科技大学成都学院", "电子科技大学中山学院", "北京理工大学珠海学院", "厦门大学嘉庚学院", "中国传媒大学南广学院",
  "同济大学浙江学院", "东南大学成贤学院", "大连理工大学城市学院", "浙江大学城市学院", "浙江大学宁波理工学院",
  "华北电力大学科技学院", "中国矿业大学徐海学院", "中国地质大学江城学院", "中国石油大学(华东)胜利学院", "中国石油大学胜利学院",
  "南京理工大学紫金学院", "南京航空航天大学金城学院", "南京师范大学中北学院", "河海大学文天学院", "苏州大学文正学院", "苏州大学应用技术学院",
  "西南交通大学希望学院", "四川大学锦江学院", "四川大学锦城学院", "吉林大学珠海学院", "山西大学商务学院",
  "云南大学滇池学院", "贵州大学明德学院", "西北大学现代学院", "长安大学兴华学院", "重庆大学城市科技学院",
  // ↓ 审计补充:这些独立学院/分校名内嵌 985/211 母校名,不剔除会误判
  "南京大学金陵学院", "华中科技大学武昌分校", "华中科技大学文华学院", "华南理工大学广州学院",
  "中山大学南方学院", "中山大学新华学院", "武汉大学珞珈学院", "武汉大学东湖分校",
  "西北工业大学明德学院", "天津大学仁爱学院", "中国地质大学长城学院",
].sort((a, b) => b.length - a.length); // 先剔长名,避免"中国石油大学胜利学院"被"中国石油大学(华东)胜利学院"半截命中

function norm(s: string): string {
  return (s || "").replace(/\s+/g, "");
}

/** 命中院校层次:先把独立学院名抹掉,再按 985 > 211 > 双一流 的优先级子串匹配。 */
function matchSchool(text: string): { tier: SchoolTier; name: string } {
  let t = norm(text);
  for (const ic of INDEPENDENT_COLLEGES) { if (ic && t.includes(ic)) t = t.split(ic).join("〖x〗"); }
  for (const s of SCHOOLS_985) if (t.includes(s)) return { tier: "985", name: s.replace("国防科学技术大学", "国防科技大学") };
  for (const s of SCHOOLS_211) if (t.includes(s)) return { tier: "211", name: s };
  for (const s of SCHOOLS_SHUANGYILIU_EXTRA) if (t.includes(s)) return { tier: "双一流", name: s };
  return { tier: "", name: "" };
}

/** 命中最高学历(博士 > 硕士 > 本科 > 大专)。
 *  英文缩写一律加词边界,避免 master/mem/mba 命中 "master Python""implement""embargo" 等普通词;
 *  先剔除"硕士生导师 / 招收博士研究生"等"带学生"语境,避免把别人的学历当成本人的。 */
function matchDegree(raw: string): Degree {
  // 去掉导师/招生语境里的学历词(那是本人带学生,不是本人学历)
  const t = (raw || "")
    .replace(/(硕士|博士)生?导师/g, "")
    .replace(/(招收|指导|培养|带教|带)[^。;,\n]{0,8}(硕士|博士|研究生)/g, "");
  if (/博士|博士研究生|博士学位|博士在读|直博|硕博连读|\bph\.?\s?d\b|doctora(?:l|te)/i.test(t)) return "博士";
  if (/硕士|碩士|硕研|研究生|保研|推免|推荐免试|本硕连读|工程硕士|专业硕士|在职硕士|\bm\.?\s?sc\b|\bmba\b|\bemba\b|\bmem\b|master(?:'s|’s)?\s+(?:degree|of)\b/i.test(t)) return "硕士";
  if (/本科|学士|學士|学士学位|全日制本科|\bbachelor(?:'s|’s)?\b|\bb\.?\s?sc\b|\bb\.?\s?eng\b/i.test(t)) return "本科";
  if (/大专|专科|高职|高专|\bassociate\s+degree\b/i.test(t)) return "大专";
  return "";
}

export function extractEducation(resumeText: string): Education {
  const text = resumeText || "";
  const { tier, name } = matchSchool(text);
  const degree = matchDegree(text);
  return { schoolTier: tier, schoolName: name, degree, postgrad: degree === "硕士" || degree === "博士" };
}

export interface TeachingIp {
  teaching: boolean; // 有教学/讲师/带教/培训/分享经验
  ip: boolean;       // 有出镜/自媒体/IP/内容创作迹象
}

/** 从简历识别"教学经验"与"出镜/IP 潜质"信号(用于加分:公司考虑做 AI 教学/出镜 IP)。 */
export function detectTeachingIp(resumeText: string): TeachingIp {
  const t = resumeText || "";
  const teaching = /讲师|授课|带教|教学|培训师|培训|课程|助教|家教|教过|公开课|技术分享|分享会|沙龙|演讲|讲座|布道|mentor|导师(?!制)/i.test(t);
  const ip = /出镜|主持|口播|镜头感|up\s?主|UP主|博主|视频号|抖音|快手|小红书|b\s?站|bilibili|油管|youtub|粉丝|自媒体|短视频|直播|个人\s?ip|内容创作|内容运营|vlog|播客|公众号|涨粉/i.test(t);
  return { teaching, ip };
}

/** 把"学历 + 徐州本地 + 教学/IP"汇成给 AI(初筛/报告)看的加分背景一句话。 */
export function backgroundSignalForPrompt(edu: Education, isLocal: boolean, tip: TeachingIp): string {
  const parts: string[] = [];
  if (edu.schoolTier) parts.push(`院校层次 ${edu.schoolTier}${edu.schoolName ? `(${edu.schoolName})` : ""}`);
  if (edu.degree) parts.push(`最高学历 ${edu.degree}`);
  if (isLocal) parts.push("徐州本地(期望/现居/上学地在徐州)");
  if (tip.teaching) parts.push("有教学/讲师/分享经验");
  if (tip.ip) parts.push("有出镜/自媒体/IP 迹象");
  if (!parts.length) return "";
  return `候选人背景(系统识别,供综合加分参考):${parts.join("、")}。这些都是加分项(名校相关专业、硕士及以上、徐州本地、能讲能出镜/有教学经验更佳),在能力相当时上调评级/优先,但不能替代实际业务落地能力。`;
}

/** 给 AI 初筛提示词用的一句话学历信号(含加分提示)。无可识别信息则返回空串。 */
export function educationSignalForPrompt(edu: Education): string {
  if (!edu.schoolTier && !edu.degree) return "";
  const parts: string[] = [];
  if (edu.schoolTier) parts.push(`毕业院校层次:${edu.schoolTier}${edu.schoolName ? `(${edu.schoolName})` : ""}`);
  if (edu.degree) parts.push(`最高学历:${edu.degree}`);
  const bonus = (edu.schoolTier === "985" || edu.schoolTier === "双一流" || edu.postgrad)
    ? "(属学历加分项:985/双一流院校或硕士及以上,同等条件下加分)"
    : "";
  return `候选人学历背景(系统识别,供参考):${parts.join("、")}${bonus}`;
}
