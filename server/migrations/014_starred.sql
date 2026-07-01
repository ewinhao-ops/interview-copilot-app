-- 简历收藏(星标):后台手动标记重点候选人,供人才库筛选/置顶。
ALTER TABLE candidates ADD COLUMN starred INTEGER DEFAULT 0;
