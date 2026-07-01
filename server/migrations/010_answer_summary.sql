-- 每题回答的 AI 内容总结(客观复述候选人讲了什么,区别于评判性 judge_summary)。
-- 与逐题评判同一次 AI 调用产出,展示在转写下方。
ALTER TABLE interview_questions ADD COLUMN answer_summary TEXT;
