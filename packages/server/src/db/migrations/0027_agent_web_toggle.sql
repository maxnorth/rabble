-- Whether the agent is reachable from web sessions (the in-app composer).
ALTER TABLE agents ADD COLUMN web_enabled boolean NOT NULL DEFAULT true;
