#!/usr/bin/env node
// 把本地 候选人简历/**/*.md 采集回填到飞书「简历库」多维表。
//   - 已有真实简历文本的记录：跳过（不覆盖）
//   - 简历文本为空 / 占位符的记录：补写
//   - 表里不存在的候选人：新建记录（邀约状态=未邀约，审核状态=待确认）
// 用法：
//   node scripts/backfill-resume-text.mjs            # dry-run，只打印计划
//   node scripts/backfill-resume-text.mjs --write    # 实际写入飞书

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const resumeDir = join(repoRoot, "候选人简历");
const larkCliPath = process.env.LARK_CLI_PATH || "lark-cli";
const configPath = resolve(__dirname, "../src/renderer/data/feishuResumeBaseConfig.json");
const WRITE = process.argv.includes("--write");

const PLACEHOLDER = /待 ?Boss|待同步|占位|原始简历/;

function runLark(args) {
  const stdout = execFileSync(larkCliPath, args, { encoding: "utf8", maxBuffer: 40 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function cell(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(cell).filter(Boolean).join("、");
  if (typeof value === "object") return cell(value.text || value.name || value.value || "");
  return String(value).trim();
}

function parseResumeFile(fileName) {
  const base = fileName.replace(/\.md$/, "");
  const dash = base.indexOf("-");
  const name = dash >= 0 ? base.slice(0, dash) : base;
  const role = dash >= 0 ? base.slice(dash + 1) : "AI应用工程师";
  return { name, role };
}

function collectLocalResumes() {
  const out = [];
  if (!existsSync(resumeDir)) return out;
  for (const day of readdirSync(resumeDir)) {
    const dir = join(resumeDir, day);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      const { name, role } = parseResumeFile(file);
      out.push({ name, role, collectedDate: day, text: readFileSync(join(dir, file), "utf8").trim() });
    }
  }
  return out;
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const baseToken = config.base.token;
const tableId = config.table.id;

const listed = runLark([
  "base", "+record-list", "--as", "user",
  "--base-token", baseToken, "--table-id", tableId,
  "--field-id", "姓名", "--field-id", "Boss名称", "--field-id", "简历文本",
  "--format", "json", "--limit", "500"
]);
const cols = listed.data.fields;
const rows = listed.data.data;
const recordIds = listed.data.record_id_list;
const idxName = cols.indexOf("姓名");
const idxBoss = cols.indexOf("Boss名称");
const idxText = cols.indexOf("简历文本");

const recordByName = new Map();
rows.forEach((row, index) => {
  const recordId = recordIds[index];
  const text = cell(row[idxText]);
  for (const key of [cell(row[idxName]), cell(row[idxBoss])]) {
    if (key) recordByName.set(key, { recordId, text });
  }
});

const local = collectLocalResumes();
const plan = { skip: [], fill: [], create: [] };

for (const resume of local) {
  const match = recordByName.get(resume.name);
  if (!match) {
    plan.create.push(resume);
  } else if (match.text && !PLACEHOLDER.test(match.text)) {
    plan.skip.push(resume.name);
  } else {
    plan.fill.push({ ...resume, recordId: match.recordId });
  }
}

console.log(`本地简历文件：${local.length} 个 | 简历库记录：${rows.length} 条`);
console.log(`计划 → 跳过(已有文本) ${plan.skip.length} | 补写 ${plan.fill.length} | 新建 ${plan.create.length}`);
if (plan.fill.length) console.log("  补写:", plan.fill.map((item) => item.name).join("、"));
if (plan.create.length) console.log("  新建:", plan.create.map((item) => item.name).join("、"));

if (!WRITE) {
  console.log("\n（dry-run，未写入。加 --write 执行）");
  process.exit(0);
}

let filled = 0;
let created = 0;
for (const item of plan.fill) {
  runLark([
    "base", "+record-upsert", "--as", "user",
    "--base-token", baseToken, "--table-id", tableId,
    "--record-id", item.recordId,
    "--json", JSON.stringify({ 简历文本: item.text, 岗位方向: item.role })
  ]);
  filled += 1;
}
for (const item of plan.create) {
  runLark([
    "base", "+record-batch-create", "--as", "user",
    "--base-token", baseToken, "--table-id", tableId,
    "--json", JSON.stringify({
      fields: ["姓名", "Boss名称", "岗位方向", "简历文本", "收录日期", "邀约状态", "审核状态"],
      rows: [[item.name, item.name, item.role, item.text, item.collectedDate, "未邀约", "待确认"]]
    })
  ]);
  created += 1;
}
console.log(`\n完成：补写 ${filled} 条，新建 ${created} 条。`);
