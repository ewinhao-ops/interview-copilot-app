-- 候选人本人照片(面试时自拍,用于确认面试者身份)。存 base64 data URL。
ALTER TABLE candidates ADD COLUMN photo TEXT;
ALTER TABLE candidates ADD COLUMN photo_taken_at TEXT;
