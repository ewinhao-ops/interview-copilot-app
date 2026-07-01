-- 候选人是否徐州本地(期望/现居城市为徐州),供人才库筛选。入库/同步时由 detectXuzhouLocal 写入。
ALTER TABLE candidates ADD COLUMN is_local INTEGER DEFAULT 0; -- 1 = 徐州本地
CREATE INDEX IF NOT EXISTS idx_candidates_local ON candidates(is_local);
