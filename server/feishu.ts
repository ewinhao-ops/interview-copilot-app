// 飞书 lark-cli 适配(过渡期只读 + 受白名单约束的回写)。
// 改造计划中飞书最终退役;这里保留是为了迁移与过渡期同步。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { config } from "./config.js";

export const feishuFields = [
  "Boss名称", "姓名", "岗位方向", "收录日期", "目前所在地", "简历文本", "飞书记录ID",
  "邀约状态", "邀约时间", "预约提交时间", "审核状态", "面试日期", "开始时间",
  "结束时间", "面试状态", "面试问题MD", "面试过程MD", "评分", "评级", "评估报告", "报告生成时间",
];

export function readFeishuConfig() {
  if (!existsSync(config.feishuConfigPath)) {
    throw new Error("还没有生成飞书简历库配置，请先运行 npm run feishu:create-resume-library");
  }
  return JSON.parse(readFileSync(config.feishuConfigPath, "utf8")) as {
    table: { id: string; url: string };
    base: { token: string; url: string };
  };
}

export function runLark(args: string[]) {
  const output = execFileSync(config.larkCliPath, args, {
    cwd: config.rootDir,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
  });
  return JSON.parse(output);
}

export function readFeishuResumeRecords(cfg = readFeishuConfig()) {
  const fieldProjection = feishuFields.flatMap((field) => ["--field-id", field]);
  const limit = 200;
  const records: ReturnType<typeof rowToResumeRecord>[] = [];
  for (let offset = 0; ; offset += limit) {
    const payload = runLark([
      "base", "+record-list", "--as", "user",
      "--base-token", cfg.base.token, "--table-id", cfg.table.id,
      ...fieldProjection, "--format", "json", "--limit", String(limit), "--offset", String(offset),
    ]) as { data?: { data?: unknown[][]; record_id_list?: string[]; has_more?: boolean } };
    const rows = payload.data?.data || [];
    const recordIds = payload.data?.record_id_list || [];
    records.push(...rows.map((row, index) => rowToResumeRecord(row, recordIds[index] || `feishu-${offset + index}`)));
    if (!payload.data?.has_more || rows.length === 0) break;
  }
  return records;
}

export function upsertFeishuRecord(recordId: string, fields: Record<string, string>) {
  if (!recordId || !recordId.startsWith("rec")) return false;
  const cfg = readFeishuConfig();
  runLark([
    "base", "+record-upsert", "--as", "user",
    "--base-token", cfg.base.token, "--table-id", cfg.table.id,
    "--record-id", recordId, "--json", JSON.stringify(fields),
  ]);
  return true;
}

/** 回写简历库字段白名单；数组表示该 select 字段的合法选项。 */
export const feishuWriteWhitelist: Record<string, string[] | null> = {
  目前所在地: null,
  评估报告: null, 评分: null, 报告生成时间: null, 面试问题MD: null, 面试过程MD: null,
  评级: ["A", "A-", "B+", "B", "C+", "待定"],
  面试状态: ["待确认", "已安排", "已完成"],
  邀约状态: ["未邀约", "已发", "已提交待确认", "已安排", "已完成", "已评估"],
  审核状态: ["待确认", "已通过", "已拒绝", "无需审核"],
};

export function sanitizeFeishuWriteFields(rawFields: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawFields)) {
    if (!(key in feishuWriteWhitelist)) continue;
    const stringValue = value == null ? "" : String(value);
    const options = feishuWriteWhitelist[key];
    if (Array.isArray(options) && stringValue && !options.includes(stringValue)) continue;
    out[key] = stringValue;
  }
  return out;
}

export function resolveFeishuRecordIdByName(name: string): string | null {
  if (!name) return null;
  try {
    const records = readFeishuResumeRecords() as Array<{ feishuRecordId: string; name: string; bossName: string }>;
    const hit = records.find((r) => r.name === name || r.bossName === name);
    return hit ? hit.feishuRecordId : null;
  } catch {
    return null;
  }
}

export function rowToResumeRecord(row: unknown[], recordId: string) {
  const field = (name: string) => normalizeCell(row[feishuFields.indexOf(name)]);
  const score = Number(field("评分"));
  return {
    id: `feishu-${recordId}`,
    feishuRecordId: recordId,
    bossName: field("Boss名称") || field("姓名"),
    name: field("姓名") || field("Boss名称"),
    role: field("岗位方向") || "AI应用工程师",
    collectedDate: field("收录日期") || new Date().toISOString().slice(0, 10),
    currentLocation: field("目前所在地") || undefined,
    resumeText: field("简历文本"),
    resumePath: "飞书多维表",
    invitationStatus: invitationStatusFromFeishu(field("邀约状态")),
    invitedAt: field("邀约时间") || undefined,
    bookingSubmittedAt: field("预约提交时间") || undefined,
    interviewDate: field("面试日期") || undefined,
    interviewStart: field("开始时间") || undefined,
    interviewEnd: field("结束时间") || undefined,
    interviewStatus: eventStatusFromFeishu(field("面试状态")),
    score: Number.isFinite(score) ? score : undefined,
    priority: priorityFromFeishu(field("评级")),
    reportGeneratedAt: field("报告生成时间") || undefined,
  };
}

export function invitationStatusFromFeishu(value: string) {
  const map: Record<string, string> = {
    未邀约: "uninvited", 已发: "invited", 已提交待确认: "submitted_pending_review",
    已安排: "scheduled", 已完成: "completed", 已评估: "evaluated",
  };
  return map[value] || "uninvited";
}
export function eventStatusFromFeishu(value: string) {
  if (value === "已完成") return "done";
  if (value === "已安排") return "scheduled";
  if (value === "待确认") return "pending";
  return undefined;
}
export function priorityFromFeishu(value: string) {
  return ["A", "A-", "B+", "B", "C+", "待定"].includes(value) ? value : undefined;
}
export function normalizeCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(normalizeCell).filter(Boolean).join("、");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return normalizeCell(record.text || record.name || record.value || Object.values(record));
  }
  return String(value);
}
