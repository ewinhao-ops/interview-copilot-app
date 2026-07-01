-- 转写失败时备份录音到 COS,以便服务/账号恢复后重转(避免候选人回答永久丢失)。
-- audio_key: 备份到 COS 的 PCM 音频对象 key(仅在转写失败且 COS 已配时写入);重转成功后清空。
-- audio_sample_rate: 该备份音频的采样率(重转时需要,前端录音采样率不固定为 16000)。
ALTER TABLE interview_questions ADD COLUMN audio_key TEXT;
ALTER TABLE interview_questions ADD COLUMN audio_sample_rate INTEGER;
