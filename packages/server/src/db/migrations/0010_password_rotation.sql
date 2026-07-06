-- Invited members sign in with a temp password; they must set their own
-- before doing anything else.
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
