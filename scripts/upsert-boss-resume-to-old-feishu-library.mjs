#!/usr/bin/env node
// Deprecated compatibility wrapper.
//
// BOSS recruiting now has exactly one official Feishu candidate table.
// Keep this old script path as a safe shim so accidental legacy calls are
// redirected to the official single-table writer instead of the historical
// 面试人员汇总 table.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const officialWriter = resolve(__dirname, "upsert-boss-resume-to-feishu-library.mjs");
const result = spawnSync(process.execPath, [officialWriter, ...process.argv.slice(2)], {
  stdio: "inherit"
});

process.exit(result.status ?? 1);
