-- 面试系统 SQLite 初始 schema (改造执行计划 阶段1.2)
-- 所有时间字段统一存 ISO8601 字符串。json 字段存序列化后的文本。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 人才主表：BOSS 自动化 / 飞书迁移 / 手动录入都进这里
CREATE TABLE IF NOT EXISTS candidates (
  id                TEXT PRIMARY KEY,
  feishu_record_id  TEXT,
  boss_name         TEXT,
  name              TEXT NOT NULL,
  role              TEXT,
  resume_text       TEXT DEFAULT '',
  resume_path       TEXT,
  source            TEXT DEFAULT 'manual',      -- boss | feishu | manual
  contact_status    TEXT,                       -- 未回应人才库用
  invitation_status TEXT DEFAULT 'uninvited',   -- uninvited|invited|submitted_pending_review|scheduled|completed|evaluated
  current_stage     TEXT DEFAULT 'intake',      -- intake|screened|invited|interviewing|reviewed|result
  collected_date    TEXT,
  score             REAL,
  priority          TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_stage ON candidates(current_stage);
CREATE INDEX IF NOT EXISTS idx_candidates_feishu ON candidates(feishu_record_id);
CREATE INDEX IF NOT EXISTS idx_candidates_name ON candidates(name);

-- 每日 AI 初筛结果(阶段3 写入；阶段1 先建表)
CREATE TABLE IF NOT EXISTS screenings (
  id                  TEXT PRIMARY KEY,
  candidate_id        TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  job_profile_id      TEXT,
  rating              TEXT,        -- 推荐 | 待定 | 不推荐
  reasons             TEXT,        -- json: [{point, quote}]
  risks               TEXT,        -- json: string[]
  generated_questions TEXT,        -- json: GeneratedQuestion[]
  model               TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_screenings_candidate ON screenings(candidate_id);

-- 面试会话(对应旧 interview-sessions)
CREATE TABLE IF NOT EXISTS interviews (
  id                  TEXT PRIMARY KEY,
  candidate_id        TEXT REFERENCES candidates(id) ON DELETE SET NULL,
  candidate_name      TEXT,
  candidate_role      TEXT,
  feishu_record_id    TEXT,
  invite_token        TEXT,        -- 候选人邀约链接 token
  invite_expires_at   TEXT,        -- 48h 有效期
  room_token          TEXT,
  booking_id          TEXT,
  booking_token       TEXT,
  booking_room_token  TEXT,
  status              TEXT DEFAULT 'ready',   -- ready|in_progress|completed|terminated
  current_question_id TEXT,
  host_started_at     TEXT,
  host_ended_at       TEXT,
  candidate_entered_at   TEXT,
  candidate_last_seen_at TEXT,
  candidate_viewing_question_id TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interviews_candidate ON interviews(candidate_id);
CREATE INDEX IF NOT EXISTS idx_interviews_invite ON interviews(invite_token);
CREATE INDEX IF NOT EXISTS idx_interviews_room ON interviews(room_token);

-- 逐题：题面 + 转写 + 评判
CREATE TABLE IF NOT EXISTS interview_questions (
  id                 TEXT PRIMARY KEY,           -- 全局 PK: interview_id + '::' + question_id
  interview_id       TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  question_id        TEXT NOT NULL,              -- 前端用的 questionId(仅在单场会话内唯一)
  ord                INTEGER NOT NULL DEFAULT 0,
  stage              TEXT,
  category           TEXT,
  dimension          TEXT,
  signal             TEXT,
  prompt             TEXT NOT NULL,    -- 题面(originalQuestion)
  status             TEXT DEFAULT 'pending',  -- pending|pushed|recording|answered
  raw_transcript     TEXT DEFAULT '',
  answer_transcript  TEXT DEFAULT '',  -- correctedTranscript / 整段转写结果
  transcript_segments TEXT,            -- json: 分段(带回执序号)
  audio_received     INTEGER DEFAULT 0,-- 回执:服务端确认已收到的段数
  judge_score        TEXT,
  judge_grade        TEXT,             -- A|B|C|D
  judge_quotes       TEXT,             -- json: string[] 候选人原话引用
  judge_gaps         TEXT,             -- json: string[] 未讲清的点
  judge_summary      TEXT,
  followup_question  TEXT,             -- 基于本题回答自动生成的追问
  follow_ups         TEXT,             -- json: 历史追问列表
  attachments        TEXT,             -- json: 候选人补充材料(过渡期保留)
  answer_started_at  TEXT,
  answer_completed_at TEXT,
  created_at         TEXT NOT NULL,
  UNIQUE(interview_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_questions_interview ON interview_questions(interview_id);

-- 总报告 + 二面复核清单
CREATE TABLE IF NOT EXISTS evaluations (
  id              TEXT PRIMARY KEY,
  interview_id    TEXT REFERENCES interviews(id) ON DELETE CASCADE,
  candidate_id    TEXT REFERENCES candidates(id) ON DELETE CASCADE,
  summary         TEXT,
  recommendation  TEXT,
  score           TEXT,
  grade           TEXT,
  review_checklist TEXT,   -- json: 二面复核清单
  raw             TEXT,     -- json: 完整报告对象(兼容旧 EvaluationReport)
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evaluations_candidate ON evaluations(candidate_id);

-- 二面预约
CREATE TABLE IF NOT EXISTS bookings (
  id            TEXT PRIMARY KEY,
  candidate_id  TEXT REFERENCES candidates(id) ON DELETE SET NULL,
  candidate_name TEXT,
  token         TEXT,
  room_token    TEXT,
  matched_resume_id TEXT,
  slot_date     TEXT,
  slot_start    TEXT,
  slot_end      TEXT,
  review_status TEXT DEFAULT 'pending',  -- pending|approved|rejected
  submitted_at  TEXT,
  reviewed_at   TEXT,
  raw           TEXT,     -- json: 完整提交对象(保真)
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 开放可约时段
CREATE TABLE IF NOT EXISTS availability (
  id          TEXT PRIMARY KEY,
  date        TEXT,
  start       TEXT,
  end         TEXT,
  status      TEXT DEFAULT 'open',
  raw         TEXT
);

-- 后台生成的预约链接配置
CREATE TABLE IF NOT EXISTS booking_links (
  token       TEXT PRIMARY KEY,
  config      TEXT NOT NULL,   -- json
  created_at  TEXT NOT NULL
);

-- 键值设置：岗位画像 / 题库 / 模型密钥等
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,   -- json
  updated_at  TEXT NOT NULL
);
