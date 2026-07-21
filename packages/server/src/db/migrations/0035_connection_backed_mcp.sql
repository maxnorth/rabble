-- Connection-backed MCP servers: a third credential mode where the server's
-- service credential is an existing Connection (e.g. the Slack workspace
-- bot from Admin > Connections) instead of a pasted org token. If the
-- connection is later deleted the pointer clears and calls fail with a
-- clear "no usable credential" error rather than a dangling reference.
ALTER TABLE mcp_servers
  ADD COLUMN connection_id uuid REFERENCES connections(id) ON DELETE SET NULL;
