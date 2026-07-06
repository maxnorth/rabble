-- Shared-surface threads have multiple human participants: record who
-- authored each user message (null = the session's user, for old rows).
ALTER TABLE messages ADD COLUMN author_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
