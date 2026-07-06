-- Sub-agent edges carry a human note ("Called before any deploy action").
ALTER TABLE agent_links ADD COLUMN note text NOT NULL DEFAULT '';
