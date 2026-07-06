-- Teams (hierarchical, with a pinned org-wide "Everyone")
CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  parent_team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  is_everyone boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX teams_org_slug_idx ON teams (org_id, slug);

CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

-- Domains (flat, optional, grant-carrying agent collections)
CREATE TABLE domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  slug text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX domains_org_slug_idx ON domains (org_id, slug);

ALTER TABLE agents ADD COLUMN domain_id uuid REFERENCES domains(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE agents ADD COLUMN capabilities jsonb NOT NULL DEFAULT '{}';

-- Grants: who (user|team) . right (use|edit|admin) . target (agent|domain)
CREATE TABLE grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'team')),
  subject_id uuid NOT NULL,
  access_right text NOT NULL CHECK (access_right IN ('use', 'edit', 'admin')),
  target_type text NOT NULL CHECK (target_type IN ('agent', 'domain')),
  target_id uuid NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX grants_unique_idx
  ON grants (org_id, subject_type, subject_id, target_type, target_id);
CREATE INDEX grants_target_idx ON grants (target_type, target_id);

-- MCP servers (org-level tool endpoints)
CREATE TABLE mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  slug text NOT NULL,
  name text NOT NULL,
  url text NOT NULL,
  category text NOT NULL DEFAULT 'Tools',
  encrypted_token text,
  tools jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mcp_servers_org_slug_idx ON mcp_servers (org_id, slug);

CREATE TABLE agent_mcp_servers (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, server_id)
);

CREATE TABLE agent_tool_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  auth_type text NOT NULL DEFAULT 'service' CHECK (auth_type IN ('service', 'user'))
);
CREATE UNIQUE INDEX agent_tool_configs_idx
  ON agent_tool_configs (agent_id, server_id, tool_name);

-- Agents wired into other agents as callable tools
CREATE TABLE agent_links (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  sub_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, sub_agent_id)
);

-- Automations (scheduling executes via Hatchet in a later phase)
CREATE TABLE automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name text NOT NULL,
  schedule text NOT NULL,
  prompt text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Connections (first-party platform connections; distinct from MCP servers)
CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  vendor text NOT NULL,
  name text NOT NULL,
  roles jsonb NOT NULL DEFAULT '[]',
  base_url text,
  encrypted_token text,
  status text NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'needs-auth', 'error')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- API keys (programmatic access)
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  name text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('read', 'write', 'admin')),
  prefix text NOT NULL,
  key_hash text NOT NULL,
  created_by uuid REFERENCES users(id),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX api_keys_hash_idx ON api_keys (key_hash);

-- Audit log (control-plane changes only — NOT a session log)
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  summary text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_time_idx ON audit_events (org_id, created_at DESC);

-- Evals: live criteria + offline suites
CREATE TABLE eval_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE eval_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  criterion_id uuid NOT NULL REFERENCES eval_criteria(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  passed boolean NOT NULL,
  reasoning text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX eval_results_session_idx ON eval_results (session_id);
CREATE INDEX eval_results_criterion_idx ON eval_results (criterion_id, created_at DESC);

CREATE TABLE eval_suites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name text NOT NULL,
  gating boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE eval_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id uuid NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
  name text NOT NULL,
  input text NOT NULL,
  rubric text NOT NULL,
  source_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE suite_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id uuid NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE case_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES suite_runs(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
  passed boolean NOT NULL,
  output text NOT NULL DEFAULT '',
  reasoning text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Starred agents (pin to the Agents rail)
CREATE TABLE user_favorites (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, agent_id)
);

-- Profile: personal credentials used when an agent acts "as you"
CREATE TABLE user_connected_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor text NOT NULL,
  label text NOT NULL DEFAULT '',
  encrypted_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_connected_accounts_idx
  ON user_connected_accounts (user_id, vendor);

ALTER TABLE users ADD COLUMN preferences jsonb NOT NULL DEFAULT '{}';

-- Backfill: every org gets a pinned "Everyone" team containing all users;
-- existing agents are attributed to the org owner.
INSERT INTO teams (org_id, slug, name, is_everyone)
SELECT id, 'everyone', 'Everyone', true FROM orgs
WHERE NOT EXISTS (
  SELECT 1 FROM teams t WHERE t.org_id = orgs.id AND t.is_everyone
);

INSERT INTO team_members (team_id, user_id)
SELECT t.id, u.id
FROM users u
JOIN teams t ON t.org_id = u.org_id AND t.is_everyone
ON CONFLICT DO NOTHING;

UPDATE agents SET created_by = (
  SELECT id FROM users
  WHERE users.org_id = agents.org_id AND role = 'owner'
  LIMIT 1
) WHERE created_by IS NULL;
