-- Durable inbound-event dedup. Replaces a process-local in-memory Set so a
-- redelivery is suppressed across transports (Slack Events + Socket Mode),
-- across processes (multi-instance), and across restarts (closing a GitHub
-- replay window, since GitHub deliveries carry no timestamp to bound). The PK
-- makes the insert atomic, so two concurrent identical deliveries can't both
-- win. Keyed by the same string the old Set used (Slack event_id, or
-- "gh:<deliveryId>").
CREATE TABLE delivered_events (
  event_id text PRIMARY KEY,
  delivered_at timestamptz NOT NULL DEFAULT now()
);
