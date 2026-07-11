-- MCP library & governance:
-- 1. Server-level tool disable: tools an org admin turns off at the
--    definition level, hidden from every agent using the server.
-- 2. library_key: which curated library entry (if any) this server came
--    from — presentation only, the server is a normal row either way.
-- 3. Grants can target mcp-servers: no grants = anyone can attach the
--    server to their agents; grants restrict attachment to the grantees
--    (same semantics as model grants).
ALTER TABLE mcp_servers ADD COLUMN disabled_tools jsonb NOT NULL DEFAULT '[]';
ALTER TABLE mcp_servers ADD COLUMN library_key text;

ALTER TABLE grants DROP CONSTRAINT grants_target_type_check;
ALTER TABLE grants ADD CONSTRAINT grants_target_type_check
  CHECK (target_type IN ('agent', 'domain', 'model', 'mcp-server'));
