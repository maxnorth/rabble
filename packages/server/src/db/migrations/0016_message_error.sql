-- A failed agent turn is still part of the record. Persist the failure on the
-- agent message so a reload shows the error inline instead of a dangling user
-- question with no reply — sessions stay complete transcripts.
ALTER TABLE messages ADD COLUMN error text;
