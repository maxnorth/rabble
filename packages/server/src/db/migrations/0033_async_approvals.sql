-- Async approvals (docs/DECISIONS.md "Approvals are asynchronous"): a turn
-- never blocks on a human decision. The ask is durable — it survives the
-- turn, the process, and can be decided hours later from any surface. On
-- approval the platform executes the recorded call verbatim and notifies
-- the agent in a follow-up turn.
CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id),
  -- Who must decide (and whose identity the action runs under).
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('mcp', 'platform')),
  tool_name text NOT NULL,
  server_id uuid REFERENCES mcp_servers(id) ON DELETE CASCADE,
  server_name text,
  input jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'ran-as-service', 'denied', 'expired')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  executed_at timestamptz,
  output text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_pending_by_session ON approvals (session_id) WHERE status = 'pending';
CREATE INDEX approvals_org ON approvals (org_id);
