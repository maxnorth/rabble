-- Surface delivery: sessions carry their origin surface, and Slack
-- connections hold the signing secret that authenticates inbound events.

ALTER TABLE sessions ADD COLUMN surface text NOT NULL DEFAULT 'Web';
ALTER TABLE sessions ADD COLUMN surface_key text;
CREATE UNIQUE INDEX sessions_surface_key_idx
  ON sessions (surface_key) WHERE surface_key IS NOT NULL;

ALTER TABLE connections ADD COLUMN encrypted_signing_secret text;
