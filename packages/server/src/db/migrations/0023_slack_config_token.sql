-- App configuration tokens let Rabble read + update the Slack app's manifest
-- (scopes, events, socket mode, interactivity) via the apps.manifest.* API.
--   encrypted_config_token         – access token (xoxe.xoxp-…), 12h lifetime
--   encrypted_config_refresh_token – refresh token (xoxe-…), rotates the pair
-- Both AES-GCM encrypted like every other secret.
ALTER TABLE connections
  ADD COLUMN encrypted_config_token text,
  ADD COLUMN encrypted_config_refresh_token text;
