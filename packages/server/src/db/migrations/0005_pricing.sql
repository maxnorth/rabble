-- Cost accounting: models carry USD prices per million tokens so Stats can
-- report spend. Nullable — unpriced models are excluded from $ figures.

ALTER TABLE models
  ADD COLUMN price_input_per_mtok numeric(10, 4),
  ADD COLUMN price_output_per_mtok numeric(10, 4);
