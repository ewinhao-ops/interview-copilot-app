-- 候选人档案分享链接:把某候选人的完整面试情况(资料/沟通/面试评价/评估反馈)以只读链接分享给 HR 或他人。
-- 失效规则:可设最大查看次数(max_views)与到期时间(valid_until),任一超限即失效;也可后台手动撤销(revoked)。
CREATE TABLE IF NOT EXISTS share_links (
  token TEXT PRIMARY KEY,             -- sh-xxxxxxxxxxxx
  candidate_id TEXT NOT NULL,
  max_views INTEGER,                  -- 可空 = 不限次数
  valid_until TEXT,                   -- ISO 时间,可空 = 不限时间
  view_count INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0, -- 1 = 已手动撤销
  note TEXT,                          -- 备注(给谁/用途,仅后台可见)
  created_at TEXT NOT NULL,
  last_viewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_share_links_candidate ON share_links(candidate_id);
