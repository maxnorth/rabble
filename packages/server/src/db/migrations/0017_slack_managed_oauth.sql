-- Managed Slack setup: Rabble creates the app from a manifest (via the config
-- token), stores the returned OAuth credentials, then runs the install flow to
-- capture the bot token at its callback.
--   slack_app_id           – the created app's id (for later manifest updates)
--   slack_client_id        – OAuth client id (public; used in the install URL)
--   encrypted_client_secret– OAuth client secret, for the code->token exchange
--   oauth_state            – CSRF/correlation nonce for the in-flight install
ALTER TABLE connections
  ADD COLUMN slack_app_id text,
  ADD COLUMN slack_client_id text,
  ADD COLUMN encrypted_client_secret text,
  ADD COLUMN oauth_state text;
