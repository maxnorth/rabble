-- Per-surface response mode for Slack (and future threaded surfaces):
--   all     – respond to every message in the channel (whole-channel monitoring)
--   thread  – tag to engage, then auto-respond to follow-ups in that thread
--   mention – tag-only; require a fresh @-mention for every reply, even in-thread
-- Default 'thread' matches the product default for a newly attached surface.
ALTER TABLE agent_surfaces
  ADD COLUMN response_mode text NOT NULL DEFAULT 'thread';
