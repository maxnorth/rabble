-- Slack Socket Mode: connections can hold an app-level token (xapp-...)
-- used to open a Socket Mode WebSocket instead of receiving webhooks.
ALTER TABLE connections ADD COLUMN encrypted_app_token text;
