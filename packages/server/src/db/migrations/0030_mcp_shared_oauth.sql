-- Shared OAuth donation: a shared-credential MCP server can be backed by
-- OAuth instead of a pasted token. One admin donates their account as the
-- org credential — encrypted_token holds the donated access token; these
-- carry its refresh token, expiry, and who donated it (surfaced for honesty:
-- "the org's Linear access is Alex's account").
ALTER TABLE mcp_servers ADD COLUMN encrypted_org_refresh_token text;
ALTER TABLE mcp_servers ADD COLUMN org_token_expires_at timestamptz;
ALTER TABLE mcp_servers ADD COLUMN donated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
