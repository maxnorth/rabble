-- Snapshot the model's price onto each agent message at write time so spend is
-- priced at use time for real: deleting a model (FK sets messages.model_id
-- NULL) or editing its price can no longer silently rewrite historical spend.
-- Nullable; pre-existing rows fall back to the live model rate in the spend
-- query.
ALTER TABLE messages ADD COLUMN price_input_per_mtok numeric(10, 4);
ALTER TABLE messages ADD COLUMN price_output_per_mtok numeric(10, 4);
