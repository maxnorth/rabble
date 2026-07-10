-- Automations need an identity to run as when fired by the scheduler (there
-- is no request user on a cron tick). Record the creator; scheduled runs act
-- as them. Nullable so pre-existing automations simply won't auto-fire until
-- re-saved.
ALTER TABLE automations ADD COLUMN created_by uuid REFERENCES users(id);
