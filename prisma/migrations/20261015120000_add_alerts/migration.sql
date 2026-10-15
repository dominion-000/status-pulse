-- Week 4: alerts, acknowledgements and the outbox (SP-06).
-- Apply with `prisma migrate deploy`. Do not run `prisma migrate dev` against this database: the partial unique
-- indexes in earlier migrations cannot be expressed in schema.prisma, and migrate dev may try to drop them.
-- Subscribers, plans and payment attempts (SP-07) are added by a later migration.

-- One alert per problem (SP-06.2). `state` is the service status that raised the alert. Whether an alert is open,
-- acknowledged or resolved is not stored: it follows from the acknowledgement row and the incident's status.
CREATE TABLE alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT alerts_state_check CHECK (state IN ('Degraded', 'Outage')),
  CONSTRAINT alerts_one_per_problem UNIQUE (service_id, incident_id, state)
);
CREATE INDEX alerts_project_id_created_at_idx ON alerts(project_id, created_at);
CREATE INDEX alerts_incident_id_idx ON alerts(incident_id);

-- At most one acknowledgement per alert (SP-06.4). It records who and when, and has no link to delivery.
CREATE TABLE acknowledgements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id UUID NOT NULL UNIQUE REFERENCES alerts(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every simulated email: alerts now, subscription verification and subscriber notifications later (SP-06.5).
-- `delivered_at` is set only after a confirmed send (SP-06.3). A message is claimed with a lease, so two dispatchers
-- never send the same one, and a crashed dispatcher's message becomes claimable again when the lease expires.
CREATE TABLE outbox_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  alert_id UUID REFERENCES alerts(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outbox_messages_kind_check CHECK (kind IN ('alert', 'subscription_verification', 'subscriber_notification')),
  CONSTRAINT outbox_messages_alert_link CHECK ((kind = 'alert') = (alert_id IS NOT NULL)),
  CONSTRAINT outbox_messages_attempts_check CHECK (attempts >= 0),
  CONSTRAINT outbox_messages_one_per_recipient UNIQUE (alert_id, recipient_email)
);
-- The dispatcher's claim scans only what is still undelivered.
CREATE INDEX outbox_messages_pending_idx ON outbox_messages(next_attempt_at) WHERE delivered_at IS NULL;
CREATE INDEX outbox_messages_alert_id_idx ON outbox_messages(alert_id);

-- RLS: every new table, no policies, so the Supabase Data API cannot read rows
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_messages ENABLE ROW LEVEL SECURITY;
