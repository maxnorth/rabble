-- The Builder (PRODUCT_CONTEXT §5): a built-in first-party agent that
-- creates and configures agents conversationally through platform tools,
-- plus the access-request loop it puts on J1's critical path (§6).

-- Marks first-party agents ('builder'); NULL for everything user-made.
ALTER TABLE agents ADD COLUMN builtin text;

-- A user asking for a grant (usually via the Builder detecting an access
-- limit). Approving materializes a real grant; both paths are audited.
CREATE TABLE access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  requester_user_id uuid NOT NULL REFERENCES users(id),
  target_type text NOT NULL CHECK (target_type IN ('agent', 'domain', 'model')),
  target_id uuid NOT NULL,
  access_right text NOT NULL CHECK (access_right IN ('use', 'edit', 'admin')),
  reason text NOT NULL DEFAULT '',
  via text NOT NULL DEFAULT 'web',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'denied')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX access_requests_org_status_idx ON access_requests(org_id, status);
