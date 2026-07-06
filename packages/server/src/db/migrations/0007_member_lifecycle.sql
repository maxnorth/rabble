-- Member lifecycle: accounts can be deactivated (sign-in blocked, history
-- preserved) instead of deleted, keeping sessions and audit intact.
ALTER TABLE users ADD COLUMN active boolean NOT NULL DEFAULT true;
