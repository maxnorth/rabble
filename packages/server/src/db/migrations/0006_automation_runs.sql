-- Automations become runnable: track the last execution and its session.
ALTER TABLE automations
  ADD COLUMN last_run_at timestamptz,
  ADD COLUMN last_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL;
