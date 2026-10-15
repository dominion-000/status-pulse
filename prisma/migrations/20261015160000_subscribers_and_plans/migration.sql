-- Plans, subscribers, subscriber_services and payment_attempts (SP-07).
-- Plans are seeded; every project starts on the free plan.

CREATE TABLE plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  max_services INT NOT NULL,
  max_members INT NOT NULL,
  price_cents INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT plans_max_services_check CHECK (max_services > 0),
  CONSTRAINT plans_max_members_check CHECK (max_members > 0),
  CONSTRAINT plans_price_check CHECK (price_cents >= 0)
);

INSERT INTO plans (id, name, max_services, max_members, price_cents) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'free', 3, 3, 0),
  ('a0000000-0000-4000-8000-000000000002', 'pro', 50, 20, 2000);

ALTER TABLE projects
  ADD COLUMN plan_id UUID REFERENCES plans(id);

UPDATE projects SET plan_id = 'a0000000-0000-4000-8000-000000000001' WHERE plan_id IS NULL;

ALTER TABLE projects
  ALTER COLUMN plan_id SET DEFAULT 'a0000000-0000-4000-8000-000000000001',
  ALTER COLUMN plan_id SET NOT NULL;

CREATE TABLE subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  verified_at TIMESTAMPTZ,
  verification_token_hash TEXT,
  verification_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT subscribers_email_check CHECK (char_length(btrim(email)) BETWEEN 3 AND 320),
  CONSTRAINT subscribers_one_per_project UNIQUE (project_id, email)
);

CREATE INDEX subscribers_project_id_idx ON subscribers(project_id);
CREATE INDEX subscribers_token_hash_idx ON subscribers(verification_token_hash)
  WHERE verification_token_hash IS NOT NULL;

CREATE TABLE subscriber_services (
  subscriber_id UUID NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subscriber_id, service_id)
);

CREATE INDEX subscriber_services_service_id_idx ON subscriber_services(service_id);

CREATE TABLE payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES plans(id),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  amount_cents INT NOT NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_attempts_status_check CHECK (status IN ('pending', 'succeeded', 'failed')),
  CONSTRAINT payment_attempts_amount_check CHECK (amount_cents >= 0),
  CONSTRAINT payment_attempts_one_key UNIQUE (project_id, idempotency_key)
);

CREATE INDEX payment_attempts_project_id_idx ON payment_attempts(project_id, created_at);

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_attempts ENABLE ROW LEVEL SECURITY;
