-- 候选人所在地:目前所在城市(现居)+ 期望工作城市。
-- 入库/同步时由 extractLocation 从简历文本解析兜底;后台可手改。is_local(徐州本地)仍单独保留。
ALTER TABLE candidates ADD COLUMN location_current TEXT;
ALTER TABLE candidates ADD COLUMN location_expect TEXT;
