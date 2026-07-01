#!/usr/bin/env node
// Disabled by policy: BOSS recruiting uses exactly one official Feishu table.

console.error([
  "未回应优秀人才库已废弃，禁止重新创建。",
  "所有 BOSS 招聘候选人记录都必须写入单一正式简历库。",
  "请使用 scripts/upsert-boss-resume-to-feishu-library.mjs。"
].join("\n"));

process.exit(1);
