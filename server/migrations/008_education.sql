-- 简历里识别出的学历标注:院校层次(985/211/双一流)+ 最高学历 + 是否硕士及以上。
-- 由 extractEducation() 在候选人入库/同步时写入,供人才库标注与筛选。
ALTER TABLE candidates ADD COLUMN edu_school_tier TEXT;  -- '985' | '211' | '双一流' | NULL
ALTER TABLE candidates ADD COLUMN edu_school_name TEXT;
ALTER TABLE candidates ADD COLUMN edu_degree TEXT;       -- '博士' | '硕士' | '本科' | '大专' | NULL
ALTER TABLE candidates ADD COLUMN edu_postgrad INTEGER DEFAULT 0; -- 1 = 硕士及以上
CREATE INDEX IF NOT EXISTS idx_candidates_edu_tier ON candidates(edu_school_tier);
CREATE INDEX IF NOT EXISTS idx_candidates_edu_postgrad ON candidates(edu_postgrad);
