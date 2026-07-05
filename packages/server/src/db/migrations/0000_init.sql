CREATE TABLE orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  email text NOT NULL,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_idx ON users (email);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX auth_sessions_token_idx ON auth_sessions (token_hash);

CREATE TABLE provider_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  provider text NOT NULL,
  encrypted_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX provider_keys_org_provider_idx ON provider_keys (org_id, provider);

CREATE TABLE models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  kind text NOT NULL CHECK (kind IN ('built-in', 'custom')),
  catalog_id text,
  display_name text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('anthropic', 'openai')),
  base_url text,
  model_id text NOT NULL,
  encrypted_key text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX models_org_catalog_idx ON models (org_id, catalog_id);

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  slug text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  model_id uuid REFERENCES models(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('active', 'draft')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agents_org_slug_idx ON agents (org_id, slug);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  user_id uuid NOT NULL REFERENCES users(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  title text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'agent')),
  content text NOT NULL,
  tool_calls jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_session_idx ON messages (session_id, created_at);
