-- Rights resolution runs on nearly every authenticated request and looks up a
-- user's teams with `WHERE user_id = ?`. The table's only index is the PK
-- (team_id, user_id), whose leading column is team_id, so that lookup couldn't
-- use it and fell back to a sequential scan of team_members. Index user_id.
CREATE INDEX team_members_user_idx ON team_members (user_id);
