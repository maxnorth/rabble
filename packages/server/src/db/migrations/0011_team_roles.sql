-- Team-scoped role labels (lead/member). Descriptive only: access still
-- comes exclusively from grants.
ALTER TABLE team_members ADD COLUMN team_role text NOT NULL DEFAULT 'member'
  CHECK (team_role IN ('lead', 'member'));
