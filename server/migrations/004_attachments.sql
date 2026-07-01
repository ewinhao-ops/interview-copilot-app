-- 候选人答题时上传的图片/作品附件(data URL 存库,数量不大)。
CREATE TABLE IF NOT EXISTS interview_attachments (
  id          TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL,
  question_id TEXT,
  kind        TEXT DEFAULT 'answer_image',
  name        TEXT,
  data_url    TEXT,
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_attach_interview ON interview_attachments(interview_id);
