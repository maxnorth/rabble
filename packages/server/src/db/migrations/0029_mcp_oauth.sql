-- Personal MCP servers may authenticate via OAuth (MCP's auth spec). The
-- server registration holds the discovered authorization-server endpoints and
-- the org's dynamically-registered client; each user then completes the
-- authorize flow to store their own access + refresh tokens.
ALTER TABLE mcp_servers ADD COLUMN oauth_config jsonb;
ALTER TABLE mcp_servers ADD COLUMN encrypted_oauth_client_secret text;

-- Per-user OAuth tokens live alongside the pasted-token case: encrypted_token
-- holds the access token; these carry the refresh token and its expiry.
ALTER TABLE user_mcp_credentials ADD COLUMN encrypted_refresh_token text;
ALTER TABLE user_mcp_credentials ADD COLUMN expires_at timestamptz;

-- Short-lived authorize requests: the callback matches `state` to recover the
-- PKCE verifier and the (user, server) the grant is for.
CREATE TABLE mcp_oauth_pending (
  state text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  code_verifier text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
