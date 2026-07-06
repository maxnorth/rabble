-- Agent identity extras (logo glyph + color, tone) and edit attribution
ALTER TABLE agents ADD COLUMN icon text NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN color text NOT NULL DEFAULT 'blue';
ALTER TABLE agents ADD COLUMN tone text NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN updated_by uuid REFERENCES users(id);
UPDATE agents SET updated_by = created_by WHERE updated_by IS NULL;

-- Surfaces: where an agent is reachable (a connection plus a location label)
CREATE TABLE agent_surfaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_surfaces_agent_idx ON agent_surfaces (agent_id);

-- Connections: outbound-tunnel flag (self-hosted, no inbound firewall rules)
ALTER TABLE connections ADD COLUMN tunnel boolean NOT NULL DEFAULT false;

-- Org-level settings (who can create agents, approval floor, retention)
ALTER TABLE orgs ADD COLUMN settings jsonb NOT NULL DEFAULT '{}';

-- Token accounting per message for Usage & spend
ALTER TABLE messages ADD COLUMN input_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN output_tokens integer NOT NULL DEFAULT 0;

-- Grants may now also target models (who can select a model)
ALTER TABLE grants DROP CONSTRAINT grants_target_type_check;
ALTER TABLE grants ADD CONSTRAINT grants_target_type_check
  CHECK (target_type IN ('agent', 'domain', 'model'));

-- Eval suites: gating flag already exists; nothing further
