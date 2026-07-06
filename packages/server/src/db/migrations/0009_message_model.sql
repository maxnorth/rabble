-- Cost accuracy: messages record which model produced them, so spend is
-- priced at the model actually used rather than the agent's current one.
ALTER TABLE messages ADD COLUMN model_id uuid REFERENCES models(id) ON DELETE SET NULL;
