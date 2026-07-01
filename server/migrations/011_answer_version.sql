-- 每题作答版本号:候选人重答时自增,后台异步转写写回时校验版本,避免旧录音的转写覆盖新录音。
ALTER TABLE interview_questions ADD COLUMN answer_version INTEGER DEFAULT 0;
