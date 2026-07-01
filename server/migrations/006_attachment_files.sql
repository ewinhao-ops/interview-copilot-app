-- 作品附件支持视频/大文件:落盘存储(file_path),只在库里存元数据。
-- 旧的答题图片仍用 data_url 内联;新「作品集」(kind='portfolio')用 file_path 指向磁盘文件。
ALTER TABLE interview_attachments ADD COLUMN file_path TEXT;
ALTER TABLE interview_attachments ADD COLUMN mime TEXT;
ALTER TABLE interview_attachments ADD COLUMN size INTEGER;
