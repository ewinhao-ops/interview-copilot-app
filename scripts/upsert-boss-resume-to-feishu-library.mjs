#!/usr/bin/env node
// Upsert one BOSS candidate resume into the Interview Workbench Feishu「简历库」table.
//
// Dry-run by default:
//   node scripts/upsert-boss-resume-to-feishu-library.mjs --json '{"bossName":"张三","role":"AI应用工程师/FDE","resumeText":"..."}'
//
// Write to Feishu:
//   node scripts/upsert-boss-resume-to-feishu-library.mjs --write --json '{"bossName":"张三","role":"AI应用工程师/FDE","resumeText":"..."}'
//   node scripts/upsert-boss-resume-to-feishu-library.mjs --write --file /path/to/candidate.json

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, "..");
const configPath = resolve(appRoot, "src/renderer/data/feishuResumeBaseConfig.json");
const larkCliPath = process.env.LARK_CLI_PATH || "lark-cli";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const help = args.includes("--help") || args.includes("-h");

if (help) {
  printHelp();
  process.exit(0);
}

const input = readInput();
const config = JSON.parse(readFileSync(configPath, "utf8"));
const fields = normalizeCandidate(input);

if (!fields["Boss名称"] && !fields["姓名"]) {
  throw new Error("Missing candidate name. Provide bossName/Boss名称/name/姓名.");
}

const existingRecordId = findExistingRecordId(fields["Boss名称"], fields["姓名"]);
const operation = existingRecordId ? "update" : "create";

console.log(JSON.stringify({
  write: WRITE,
  operation,
  recordId: existingRecordId || null,
  tableUrl: config.table.url,
  fields
}, null, 2));

if (!WRITE) {
  console.log("\nDry-run only. Add --write to write this candidate into Feishu.");
  process.exit(0);
}

if (existingRecordId) {
  runLark([
    "base", "+record-upsert", "--as", "user",
    "--base-token", config.base.token,
    "--table-id", config.table.id,
    "--record-id", existingRecordId,
    "--json", JSON.stringify(fields)
  ]);
  console.log(`Updated Feishu record: ${existingRecordId}`);
} else {
  runLark([
    "base", "+record-batch-create", "--as", "user",
    "--base-token", config.base.token,
    "--table-id", config.table.id,
    "--json", JSON.stringify({
      fields: Object.keys(fields),
      rows: [Object.values(fields)]
    })
  ]);
  console.log("Created Feishu record.");
}

function readInput() {
  const jsonArg = valueAfter("--json");
  if (jsonArg) return JSON.parse(jsonArg);

  const filePath = valueAfter("--file");
  if (filePath) return JSON.parse(readFileSync(resolve(filePath), "utf8"));

  if (!process.stdin.isTTY) {
    const raw = readFileSync(0, "utf8").trim();
    if (raw) return JSON.parse(raw);
  }

  printHelp();
  throw new Error("No input provided. Use --json, --file, or pipe JSON to stdin.");
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function normalizeCandidate(input) {
  const bossName = pick(input, ["bossName", "Boss名称", "boss_name", "candidateName", "候选人", "姓名", "name"]);
  const name = pick(input, ["name", "姓名", "realName", "candidateName", "候选人"]) || bossName;
  const role = pick(input, ["role", "岗位方向", "position", "job", "岗位"]) || "待判断";
  const collectedDate = pick(input, ["collectedDate", "收录日期", "记录日期"]) || todayShanghai();
  const currentLocation = pick(input, ["currentLocation", "目前所在地", "目前所在地区", "目前所在的地区", "目前所在地方", "目前所在的地方", "现居地", "现居城市", "current_city", "currentRegion"]);
  const summary = buildResumeText(input);
  const invitationStatus = normalizeInvitationStatus(
    pick(input, ["invitationStatus", "邀约状态", "联系方式/状态", "BOSS操作状态", "status"])
  );
  const rating = normalizeRating(pick(input, ["rating", "评级", "匹配等级"]));

  const out = {
    "Boss名称": bossName,
    "姓名": name,
    "岗位方向": role,
    "收录日期": collectedDate,
    "目前所在地": currentLocation,
    "简历文本": summary,
    "邀约状态": invitationStatus,
    "审核状态": pick(input, ["reviewStatus", "审核状态"]) || "待确认"
  };

  if (invitationStatus === "已发") {
    out["邀约时间"] = pick(input, ["invitedAt", "邀约时间"]) || nowShanghai();
  }
  if (rating) out["评级"] = rating;
  for (const [sourceKey, targetKey] of [
    ["bookingSubmittedAt", "预约提交时间"],
    ["预约提交时间", "预约提交时间"],
    ["interviewDate", "面试日期"],
    ["面试日期", "面试日期"],
    ["interviewStart", "开始时间"],
    ["开始时间", "开始时间"],
    ["interviewEnd", "结束时间"],
    ["结束时间", "结束时间"],
    ["interviewStatus", "面试状态"],
    ["面试状态", "面试状态"],
    ["score", "评分"],
    ["评分", "评分"],
    ["evaluationReport", "评估报告"],
    ["评估报告", "评估报告"],
    ["interviewQuestionsMd", "面试问题MD"],
    ["面试问题MD", "面试问题MD"],
    ["interviewTranscriptMd", "面试过程MD"],
    ["面试过程MD", "面试过程MD"]
  ]) {
    const value = pick(input, [sourceKey]);
    if (value) out[targetKey] = value;
  }

  if (out["面试日期"] && out["开始时间"]) {
    out["邀约状态"] = "已安排";
    out["面试状态"] = normalizeInterviewStatus(out["面试状态"]) || "已安排";
  } else if (out["面试状态"]) {
    out["面试状态"] = normalizeInterviewStatus(out["面试状态"]);
  }

  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== ""));
}

function buildResumeText(input) {
  const direct = pick(input, ["resumeText", "简历文本", "resume", "简历详情摘要", "summary", "完整信息抓取"]);
  const resumeSections = [
    line("基础信息", pick(input, ["basicInfo", "基础信息"])),
    line("求职意向", pick(input, ["jobIntent", "求职意向"])),
    line("工作经历", pick(input, ["workHistory", "工作经历"])),
    line("项目经历", pick(input, ["projectHistory", "项目经历"])),
    line("教育经历", pick(input, ["education", "教育经历"])),
    line("技能/工具", pick(input, ["skills", "技能", "工具", "技能/工具"])),
    line("作品/附件/链接", pick(input, ["works", "portfolio", "作品", "作品/附件", "portfolioLinks", "attachment", "附件"])),
    line("自我描述", pick(input, ["selfDescription", "selfIntro", "自我描述"])),
    line("联系方式线索", pick(input, ["contactClues", "联系方式线索", "联系方式"])),
    line("目前所在地", pick(input, ["currentLocation", "目前所在地", "目前所在地区", "目前所在的地区", "目前所在地方", "目前所在的地方", "现居地", "现居城市", "current_city", "currentRegion"])),
    line("薪资/地点/到岗", pick(input, ["constraints", "salaryLocationAvailability", "薪资/地点/到岗"])),
    line("匹配判断", pick(input, ["matchReason", "匹配判断", "推荐理由"]))
  ].filter(Boolean);
  const blocks = [
    direct,
    ...resumeSections,
    line("分类", pick(input, ["分类", "category"])),
    line("匹配等级", pick(input, ["匹配等级", "rating", "评级"])),
    line("关键信号", pick(input, ["关键信号", "signals", "keySignals"])),
    line("联系方式/状态", pick(input, ["联系方式/状态", "contactStatus"])),
    line("微信号", pick(input, ["微信号", "wechat"])),
    line("BOSS操作状态", pick(input, ["BOSS操作状态", "bossActionStatus"])),
    line("下一步动作", pick(input, ["下一步动作", "nextStep"])),
    line("备注", pick(input, ["备注", "note"]))
  ].filter(Boolean);
  return blocks.join("\n\n") || "待补充 BOSS 简历摘要";
}

function line(label, value) {
  return value ? `${label}: ${value}` : "";
}

function findExistingRecordId(bossName, name) {
  const payload = runLark([
    "base", "+record-list", "--as", "user",
    "--base-token", config.base.token,
    "--table-id", config.table.id,
    "--field-id", "Boss名称",
    "--field-id", "姓名",
    "--format", "json",
    "--limit", "500"
  ]);
  const rows = payload.data?.data || [];
  const ids = payload.data?.record_id_list || [];
  for (const [index, row] of rows.entries()) {
    const rowBoss = cell(row[0]);
    const rowName = cell(row[1]);
    if (bossName && rowBoss === bossName) {
      return ids[index];
    }
    if (!bossName && name && rowName === name) {
      return ids[index];
    }
  }
  return "";
}

function pick(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function normalizeInvitationStatus(value) {
  if (["未邀约", "已发", "已提交待确认", "已安排", "已完成", "已评估"].includes(value)) return value;
  if (/已发|微信|邀约|邀请|待约面|待跟进|待确认|已有微信/.test(value)) return "已发";
  if (/已约面|已安排|面试/.test(value)) return "已安排";
  return "未邀约";
}

function normalizeInterviewStatus(value) {
  if (["待确认", "已安排", "已完成"].includes(value)) return value;
  if (/完成|结束/.test(value)) return "已完成";
  if (/安排|已约|面试/.test(value)) return "已安排";
  if (/待/.test(value)) return "待确认";
  return "";
}

function normalizeRating(value) {
  const match = String(value || "").match(/A-|B\+|C\+|A|B|待定/);
  return match ? match[0] : "";
}

function cell(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(cell).filter(Boolean).join("、");
  if (typeof value === "object") return cell(value.text || value.name || value.value || "");
  return String(value).trim();
}

function todayShanghai() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function nowShanghai() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date()).replace(/\//g, "-");
}

function runLark(larkArgs) {
  const stdout = execFileSync(larkCliPath, larkArgs, {
    cwd: appRoot,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

function printHelp() {
  console.log(`Usage:
  node scripts/upsert-boss-resume-to-feishu-library.mjs [--write] --json '<candidate-json>'
  node scripts/upsert-boss-resume-to-feishu-library.mjs [--write] --file /path/to/candidate.json

Required input:
  bossName or name

Useful fields:
  role, collectedDate, currentLocation, resumeText, basicInfo, jobIntent, workHistory, projectHistory, education, skills, works, selfDescription, contactClues, salaryLocationAvailability, attachment, invitationStatus, rating, wechat, nextStep

Target:
  Feishu Interview Workbench 简历库 from src/renderer/data/feishuResumeBaseConfig.json
`);
}
