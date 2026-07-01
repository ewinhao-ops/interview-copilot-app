-- 面试日历:面试结束后手动标注的录用结果(录用 / 不录用 / 待定),与候选人正式 result 独立,只用于日历记录。
ALTER TABLE calendar_events ADD COLUMN outcome TEXT;
