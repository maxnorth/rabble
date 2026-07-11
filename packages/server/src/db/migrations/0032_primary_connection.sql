-- The org's primary connection: one designated connection (per org) that
-- serves as Rabble's own presence on that surface — platform notifications
-- route through it, and on Slack it answers as a general-purpose interface
-- (intent-routed, Builder included) instead of requiring an agent link.
ALTER TABLE connections ADD COLUMN is_primary boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX connections_one_primary_per_org
  ON connections (org_id) WHERE is_primary;
