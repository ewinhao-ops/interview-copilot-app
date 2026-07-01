-- 候选人当前所处步骤(device/photo/interview/works/finished),由候选人页心跳上报,
-- 后台据此 + last_seen 显示实时进度。
ALTER TABLE interviews ADD COLUMN candidate_stage TEXT;
