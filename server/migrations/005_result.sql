-- 录用结果决定:通过/不通过 + 给候选人的说明(候选人可在面试链接页看到)。
ALTER TABLE candidates ADD COLUMN result TEXT;        -- 'pass' | 'reject' | NULL
ALTER TABLE candidates ADD COLUMN result_note TEXT;   -- 给候选人的理由/说明
ALTER TABLE candidates ADD COLUMN result_at TEXT;     -- 决定时间
