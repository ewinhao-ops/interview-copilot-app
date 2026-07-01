#!/usr/bin/env node
// Deprecated compatibility wrapper.
//
// Promising but unresponded BOSS candidates now also belong in the single
// official Feishu「简历库」table. This wrapper keeps the old script path safe by
// redirecting accidental calls to the official single-table writer.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const officialWriter = resolve(__dirname, "upsert-boss-resume-to-feishu-library.mjs");
const result = spawnSync(process.execPath, [officialWriter, ...process.argv.slice(2)], {
  stdio: "inherit"
});

process.exit(result.status ?? 1);
