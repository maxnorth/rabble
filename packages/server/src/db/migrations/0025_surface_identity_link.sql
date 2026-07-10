-- A connection (e.g. a Slack app) is an identity, and an identity belongs to
-- exactly one agent. Surface rows carry the link; the DB refuses two agents
-- on one connection, and duplicate channel labels within a connection.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE agent_surfaces
  ADD CONSTRAINT agent_surfaces_one_agent_per_connection
  EXCLUDE USING gist (connection_id WITH =, agent_id WITH <>);

CREATE UNIQUE INDEX agent_surfaces_connection_label_idx
  ON agent_surfaces (connection_id, lower(label));
