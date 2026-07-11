-- Multi-party sessions (DECISIONS.md "Sessions are multi-party"): an Auto
-- session has no pinned agent (agent_id NULL) — an invisible orchestrator
-- decides who responds to each message — and every agent message records
-- its author so judging, spend, and audit accrue to the agent that spoke.
ALTER TABLE sessions ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE messages ADD COLUMN agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
-- Backfill: in a pinned session every agent message was spoken by its agent.
UPDATE messages m SET agent_id = s.agent_id
  FROM sessions s
  WHERE m.session_id = s.id AND m.role = 'agent';
