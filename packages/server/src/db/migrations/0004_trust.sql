-- Trust loop hardening: judge verdicts become spot-checkable (dispute ->
-- human review queue -> uphold/overturn), and out-of-scope tool attempts
-- are recorded as scope violations on the agent's track record.

ALTER TABLE eval_results
  ADD COLUMN review_status text
    CHECK (review_status IN ('open', 'upheld', 'overturned')),
  ADD COLUMN disputed_by uuid REFERENCES users(id),
  ADD COLUMN disputed_at timestamptz;

CREATE TABLE scope_violations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  tool_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scope_violations_agent_idx ON scope_violations (agent_id, created_at);
