// 一次性数据修正:把"通过一面、正在走二面"却被顶成 current_stage='result'(已出结果)的候选人,
// 按其二面真实进展回填到正确的二面阶段(second_invited / second_picked / second_confirmed)。
// 背景:管理员点"标记通过"= 通过一面给二面机会(会写 result='pass' + stage='result'),之后又约了二面,
//       但旧逻辑下 stage 一直停在 'result'。"通过(pass)"不是最终录用,这类人应显示二面进展。
// 识别条件:current_stage='result' 且 result 不是 'reject'(即 pass 或 NULL,淘汰的人不动)
//          且 存在 purpose=second-interview 的 booking_link。result 字段保留不动。
// 用法:node fix-second-interview-stage.cjs [--dry]
const Database = require("better-sqlite3");

const DB_PATH = process.env.DATABASE_PATH || "/opt/interview-copilot-data/interview.db";
const DRY = process.argv.includes("--dry");
const db = new Database(DB_PATH, { readonly: DRY });

const rows = db
  .prepare(
    `SELECT c.id, c.name, c.current_stage, c.result
       FROM candidates c
      WHERE c.current_stage = 'result' AND (c.result IS NULL OR c.result <> 'reject')
        AND EXISTS (
          SELECT 1 FROM booking_links b
           WHERE json_extract(b.config, '$.purpose') = 'second-interview'
             AND json_extract(b.config, '$.candidateId') = c.id
        )`
  )
  .all();

const getBk = db.prepare("SELECT review_status FROM bookings WHERE candidate_id = ? ORDER BY updated_at DESC LIMIT 1");
const upd = db.prepare("UPDATE candidates SET current_stage = ?, updated_at = ? WHERE id = ?");
const now = new Date().toISOString();

let fixed = 0;
for (const r of rows) {
  const bk = getBk.get(r.id);
  // 按二面进展决定目标阶段:已确认->second_confirmed;已挑待确认->second_picked;没挑/被拒/改约->second_invited
  let stage = "second_invited";
  if (bk) {
    if (bk.review_status === "approved") stage = "second_confirmed";
    else if (bk.review_status === "pending") stage = "second_picked";
    else stage = "second_invited"; // rejected / cancelled
  }
  if (!DRY) upd.run(stage, now, r.id);
  fixed++;
  console.log(`${DRY ? "[dry] " : ""}${r.name} (${r.id}): result(${r.result || "null"}) -> ${stage}  (booking=${bk ? bk.review_status : "none"})`);
}
console.log(`${DRY ? "[dry] would fix" : "fixed"}: ${fixed}`);
