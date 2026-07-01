-- 手动添加的日历事件(沟通记录 / 面试安排 / 其它待办)。二面预约不入此表,日历页直接读 bookings 自动汇总。
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,            -- YYYY-MM-DD
  start_time TEXT,              -- HH:MM,可空=全天/不限时
  end_time TEXT,
  type TEXT NOT NULL DEFAULT 'note',  -- interview(面试安排) | comm(沟通记录) | note(其它)
  title TEXT NOT NULL,
  candidate_id TEXT,            -- 可选关联候选人(便于跳详情)
  candidate_name TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(date);
