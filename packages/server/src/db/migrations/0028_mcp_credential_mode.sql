-- Whose credential an MCP server's calls ride is a property of the
-- registration, not a per-agent-per-tool choice: 'shared' (one org
-- credential) or 'personal' (each caller connects their own).
ALTER TABLE mcp_servers ADD COLUMN credential_mode text NOT NULL DEFAULT 'shared';

-- The per-tool service/user selector implied identity switching that no
-- credential backed; consent now derives from the server's mode.
ALTER TABLE agent_tool_configs DROP COLUMN auth_type;

CREATE TABLE user_mcp_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  encrypted_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, server_id)
);
