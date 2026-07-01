-- 候选人手机号:候选人在面试链接页自己填写,用于接收结果短信通知。也会从简历自动抽取兜底。
ALTER TABLE candidates ADD COLUMN phone TEXT;
