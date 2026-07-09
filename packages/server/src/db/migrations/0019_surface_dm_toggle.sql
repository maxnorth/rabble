-- Whether the linked agent answers 1:1 DMs, configured on the workspace-level
-- surface row (empty label). Channel rows ignore it.
ALTER TABLE agent_surfaces ADD COLUMN dm_enabled boolean NOT NULL DEFAULT true;
