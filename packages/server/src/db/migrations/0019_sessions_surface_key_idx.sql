-- Every inbound surface event resolves its thread's session by
-- (org_id, surface_key); without an index that's a sequential scan of the org's
-- sessions on each event. Index it. Partial (surface_key IS NOT NULL) so web
-- sessions, which have no surface_key, don't bloat the index.
CREATE INDEX sessions_org_surface_key_idx
  ON sessions (org_id, surface_key)
  WHERE surface_key IS NOT NULL;
