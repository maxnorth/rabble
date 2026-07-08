-- messages is loaded by session_id on every turn, session view, live-judge, and
-- surface delivery, almost always ordered by created_at. Postgres doesn't index
-- foreign keys automatically, so this was a sequential scan of the whole table
-- each time. Index (session_id, created_at) to match the ordered history load;
-- the leading column also serves the participant EXISTS check on the session
-- list.
CREATE INDEX messages_session_created_idx ON messages (session_id, created_at);
