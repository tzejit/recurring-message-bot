-- D1 schema for the recurring-message Telegram bot

CREATE TABLE IF NOT EXISTS chats (
  chat_id INTEGER PRIMARY KEY,
  utc_offset_minutes INTEGER NOT NULL DEFAULT 480 -- default +8:00
);

-- Each row is one exact trigger combination. A /set with multiple selected
-- days/dates/months (e.g. "every Wed and Thu" + "4th and 5th of Aug and Dec")
-- is expanded client-side into the cartesian product and inserted as several
-- rows, capped at MAX_COMBOS in worker.ts to avoid runaway explosion.
CREATE TABLE IF NOT EXISTS recurring_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  hour INTEGER NOT NULL,          -- 0-23, local time for the chat
  minute INTEGER NOT NULL,        -- 0-59, local time for the chat
  day_of_week INTEGER,            -- 0=Sunday .. 6=Saturday, NULL = every day
  day_of_month INTEGER,           -- 1-31, NULL = any day
  month INTEGER,                  -- 1-12, NULL = any month
  message_thread_id INTEGER,      -- supergroup forum topic id, NULL = general/no topic
  last_sent_key TEXT,             -- last local "YYYY-M-D H:M" this was sent, to prevent double-send
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recurring_messages_chat ON recurring_messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_recurring_messages_time ON recurring_messages(hour, minute);

-- Holds in-progress conversation state per chat (e.g. mid /set wizard)
CREATE TABLE IF NOT EXISTS sessions (
  chat_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);