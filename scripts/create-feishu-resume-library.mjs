import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const workspaceDir = resolve(rootDir, "..");
const lark = process.env.LARK_CLI_PATH || "lark-cli";
const feishuTenantUrl = (process.env.FEISHU_TENANT_URL || "https://example.feishu.cn").replace(/\/$/, "");
const outputDir = join(rootDir, "outputs", "feishu-resume-library");
const rawDir = join(outputDir, "raw");
const configPath = join(rootDir, "src", "renderer", "data", "feishuResumeBaseConfig.json");
const archivePath = join(rootDir, "src", "renderer", "data", "interviewArchive.json");
const resumeRoot = join(workspaceDir, "候选人简历");
const FORCE_NEW_BASE = process.argv.includes("--force-new-base");

mkdirSync(rawDir, { recursive: true });

if (existsSync(configPath) && !FORCE_NEW_BASE) {
  const existing = JSON.parse(readFileSync(configPath, "utf8"));
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: "系统已绑定固定飞书简历库；不会重复创建新多维表。若确需重建，请加 --force-new-base。",
    tableUrl: existing.table?.url,
    baseToken: existing.base?.token,
    tableId: existing.table?.id
  }, null, 2));
  process.exit(0);
}

const fields = [
  "Boss名称",
  "姓名",
  "岗位方向",
  "收录日期",
  "目前所在地",
  "简历文本",
  "飞书记录ID",
  "邀约状态",
  "邀约时间",
  "预约提交时间",
  "审核状态",
  "面试日期",
  "开始时间",
  "结束时间",
  "面试状态",
  "面试问题MD",
  "面试过程MD",
  "评分",
  "评级",
  "评估报告",
  "报告生成时间"
];

const fieldDefinitions = [
  textField("Boss名称"),
  textField("姓名"),
  textField("岗位方向"),
  textField("收录日期"),
  textField("目前所在地"),
  textField("简历文本"),
  textField("飞书记录ID"),
  selectField("邀约状态", ["未邀约", "已发", "已提交待确认", "已安排", "已完成", "已评估"]),
  textField("邀约时间"),
  textField("预约提交时间"),
  selectField("审核状态", ["待确认", "已通过", "已拒绝", "无需审核"]),
  textField("面试日期"),
  textField("开始时间"),
  textField("结束时间"),
  selectField("面试状态", ["待确认", "已安排", "已完成"]),
  textField("面试问题MD"),
  textField("面试过程MD"),
  textField("评分"),
  selectField("评级", ["A", "A-", "B+", "B", "C+", "待定"]),
  textField("评估报告"),
  textField("报告生成时间")
];

const archive = JSON.parse(readFileSync(archivePath, "utf8"));
const archiveByName = new Map(archive.records.map((record) => [record.name, record]));

const folderOutput = run("01-create-folder", [
  "drive",
  "+create-folder",
  "--as",
  "user",
  "--name",
  "面试工作台数据源"
]);
const folderToken = extractFolderToken(folderOutput);
if (!folderToken) throw new Error("Failed to create Feishu folder");

const baseOutput = run("02-create-base", [
  "base",
  "+base-create",
  "--as",
  "user",
  "--name",
  "面试工作台-简历库",
  "--time-zone",
  "Asia/Shanghai",
  "--folder-token",
  folderToken
]);
const baseToken = extractBaseToken(baseOutput);
const baseUrl = extractUrl(baseOutput) || `${feishuTenantUrl}/base/${baseToken}`;
if (!baseToken) throw new Error("Failed to create Feishu base");

const tableOutput = run("03-create-table", [
  "base",
  "+table-create",
  "--as",
  "user",
  "--base-token",
  baseToken,
  "--name",
  "简历库",
  "--fields",
  JSON.stringify(fieldDefinitions),
  "--view",
  JSON.stringify([{ name: "全部简历", type: "grid" }])
]);
const tableId = extractTableId(tableOutput);
if (!tableId) throw new Error("Failed to create Feishu table");

const rows = buildRows();
const chunks = chunkRowsByBytes(rows, 90_000);
for (const [index, chunk] of chunks.entries()) {
  run(`04-record-batch-create-${String(index + 1).padStart(2, "0")}`, [
    "base",
    "+record-batch-create",
    "--as",
    "user",
    "--base-token",
    baseToken,
    "--table-id",
    tableId,
    "--json",
    JSON.stringify({ fields, rows: chunk })
  ]);
}

const recordList = run("05-record-list-verify", [
  "base",
  "+record-list",
  "--as",
  "user",
  "--base-token",
  baseToken,
  "--table-id",
  tableId,
  "--field-id",
  "Boss名称",
  "--field-id",
  "邀约状态",
  "--field-id",
  "面试日期",
  "--format",
  "json",
  "--limit",
  "200"
]);

const result = {
  createdAt: new Date().toISOString(),
  folder: {
    token: folderToken,
    url: `${feishuTenantUrl}/drive/folder/${folderToken}`
  },
  base: {
    token: baseToken,
    url: baseUrl
  },
  table: {
    id: tableId,
    name: "简历库",
    url: `${baseUrl}?table=${tableId}`
  },
  fields,
  seedRecordCount: rows.length,
  syncedRecordCount: recordList?.data?.record_id_list?.length || 0,
  larkCliPath: lark
};

writeFileSync(configPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
writeFileSync(join(outputDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));

function buildRows() {
  const byName = new Map();
  for (const filePath of listMarkdownFiles(resumeRoot)) {
    const relPath = relative(workspaceDir, filePath);
    const collectedDate = basename(dirname(filePath));
    const baseName = basename(filePath, ".md");
    const [fileName, ...roleParts] = baseName.split("-");
    const resumeText = readFileSync(filePath, "utf8");
    const titleMatch = resumeText.match(/^#\s*(.+?)\s+-\s+(.+?)\s*$/m);
    const bossName = matchLine(resumeText, "BOSS昵称") || matchLine(resumeText, "姓名") || fileName;
    const name = matchLine(resumeText, "姓名") || bossName || fileName;
    const role = roleParts.join("-") || titleMatch?.[2]?.replace(/初筛记录$/, "").trim() || "AI应用工程师";
    const archiveRecord = archiveByName.get(name) || archiveByName.get(bossName);
    byName.set(name, recordToRow({
      bossName,
      name,
      role,
      collectedDate: matchLine(resumeText, "记录日期") || collectedDate,
      resumeText,
      attachment: relPath,
      archiveRecord
    }));
  }

  for (const archiveRecord of archive.records) {
    if (byName.has(archiveRecord.name)) continue;
    const interviewDate = parseInterviewDate(archiveRecord.profile?.interviewDate);
    byName.set(archiveRecord.name, rowFromValues({
      "Boss名称": archiveRecord.name,
      "姓名": archiveRecord.name,
      "岗位方向": "AI应用工程师/FDE",
      "收录日期": interviewDate.date || today(),
      "目前所在地": "",
      "简历文本": archiveRecord.resumeMarkdown || "待 Boss Skill 同步原始简历",
      "飞书记录ID": "",
      "邀约状态": "已评估",
      "邀约时间": "",
      "预约提交时间": "",
      "审核状态": "无需审核",
      "面试日期": interviewDate.date,
      "开始时间": interviewDate.start,
      "结束时间": interviewDate.end,
      "面试状态": "已完成",
      "面试问题MD": archiveRecord.questionMarkdown || "",
      "面试过程MD": archiveRecord.interviewMarkdown || "",
      "评分": String(scoreFromPriority(archiveRecord.profile?.priority)),
      "评级": archiveRecord.profile?.priority || "待定",
      "评估报告": buildReportText(archiveRecord),
      "报告生成时间": archiveRecord.profile?.interviewDate || ""
    }));
  }

  return Array.from(byName.values()).sort((a, b) => String(b[3]).localeCompare(String(a[3]), "zh-Hans-CN"));
}

function recordToRow({ bossName, name, role, collectedDate, resumeText, attachment, archiveRecord }) {
  const interviewDate = parseInterviewDate(archiveRecord?.profile?.interviewDate);
  const hasEvaluation = Boolean(archiveRecord?.profile?.priority);
  return rowFromValues({
    "Boss名称": bossName,
    "姓名": name,
    "岗位方向": role,
    "收录日期": collectedDate,
    "目前所在地": matchLine(resumeText, "目前所在地") || matchLine(resumeText, "现居地") || "",
    "简历文本": [resumeText, attachment ? `本地简历文件：${attachment}` : ""].filter(Boolean).join("\n\n"),
    "飞书记录ID": "",
    "邀约状态": hasEvaluation ? "已评估" : "未邀约",
    "邀约时间": "",
    "预约提交时间": "",
    "审核状态": hasEvaluation ? "无需审核" : "",
    "面试日期": interviewDate.date,
    "开始时间": interviewDate.start,
    "结束时间": interviewDate.end,
    "面试状态": hasEvaluation ? "已完成" : "",
    "面试问题MD": archiveRecord?.questionMarkdown || "",
    "面试过程MD": archiveRecord?.interviewMarkdown || "",
    "评分": hasEvaluation ? String(scoreFromPriority(archiveRecord.profile.priority)) : "",
    "评级": archiveRecord?.profile?.priority || parsePriority(resumeText) || "待定",
    "评估报告": archiveRecord ? buildReportText(archiveRecord) : "",
    "报告生成时间": archiveRecord?.profile?.interviewDate || ""
  });
}

function rowFromValues(values) {
  return fields.map((field) => {
    return values[field] ?? "";
  });
}

function listMarkdownFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) return listMarkdownFiles(fullPath);
      return entry.isFile() && entry.name.endsWith(".md") ? [fullPath] : [];
    })
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function matchLine(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^-\\s*${escaped}[：:]\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

function parsePriority(text) {
  const match = text.match(/推荐等级[：:]\s*([A-Z][+-]?|待定)/);
  return match?.[1] || "";
}

function parseInterviewDate(value = "") {
  const match = String(value).match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  if (!match) return { date: "", start: "", end: "" };
  return { date: match[1], start: match[2], end: addMinutes(match[2], 40) };
}

function addMinutes(time, minutes) {
  const [hour, minute] = time.split(":").map(Number);
  const date = new Date(Date.UTC(2026, 0, 1, hour, minute + minutes));
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function scoreFromPriority(priority) {
  const scores = { A: 92, "A-": 86, "B+": 78, B: 72, "C+": 62, "待定": 70 };
  return scores[priority] || 70;
}

function buildReportText(record) {
  return [
    record.profile?.situation ? `面试情况：${record.profile.situation}` : "",
    record.profile?.judgement ? `对面试人员的判断：${record.profile.judgement}` : ""
  ].filter(Boolean).join("\n\n");
}

function textField(name) {
  return { name, type: "text" };
}

function selectField(name, optionNames) {
  return {
    name,
    type: "select",
    multiple: false,
    options: optionNames.map((optionName, index) => ({
      name: optionName,
      hue: ["Blue", "Green", "Yellow", "Red", "Purple", "Gray"][index % 6],
      lightness: "Lighter"
    }))
  };
}

function chunkRowsByBytes(rows, maxBytes) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    if (current.length && currentBytes + rowBytes > maxBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function run(label, args) {
  const output = execFileSync(lark, args, {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024
  });
  const parsed = JSON.parse(output);
  writeFileSync(join(rawDir, `${label}.json`), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return parsed;
}

function stringValues(obj) {
  const values = [];
  const visit = (node) => {
    if (typeof node === "string") values.push(node);
    else if (node && typeof node === "object") Object.values(node).forEach(visit);
  };
  visit(obj);
  return values;
}

function firstByKey(obj, keys) {
  let result;
  const visit = (node) => {
    if (result || !node || typeof node !== "object") return;
    for (const key of keys) {
      if (typeof node[key] === "string") {
        result = node[key];
        return;
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(obj);
  return result;
}

function firstStringMatching(obj, regex) {
  return stringValues(obj).find((value) => regex.test(value));
}

function extractFolderToken(output) {
  return firstByKey(output, ["folder_token", "token"]) || firstStringMatching(output, /fld[a-zA-Z0-9]+/);
}

function extractBaseToken(output) {
  return firstByKey(output, ["app_token", "base_token", "token"]) || firstStringMatching(output, /[A-Za-z0-9]{20,}/);
}

function extractTableId(output) {
  return firstByKey(output, ["table_id"]) || firstStringMatching(output, /^tbl[a-zA-Z0-9]+/);
}

function extractUrl(output) {
  return firstStringMatching(output, /^https:\/\//);
}
