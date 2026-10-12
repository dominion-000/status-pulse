-- Week 3: status calculation and incidents (SP-04, SP-05).
-- Apply with `prisma migrate deploy`. Do not run `prisma migrate dev` against this database: the partial unique
-- indexes below cannot be expressed in schema.prisma, and migrate dev may try to drop indexes it does not know.

-- The status shown, and the status derived from results underneath an override (see core/status.ts).
ALTER TABLE services
  ADD COLUMN computed_status TEXT NOT NULL DEFAULT 'Unknown',
  ADD COLUMN computed_since TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN last_result_at TIMESTAMPTZ,
  ADD CONSTRAINT services_computed_status_check CHECK (computed_status IN ('Unknown', 'Operational', 'Degraded', 'Outage'));

CREATE TABLE service_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  computed_status TEXT NOT NULL,
  source TEXT NOT NULL,
  caused_by_result_id UUID REFERENCES check_results(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT service_status_history_status_check CHECK (status IN ('Unknown', 'Operational', 'Degraded', 'Outage')),
  CONSTRAINT service_status_history_computed_status_check CHECK (computed_status IN ('Unknown', 'Operational', 'Degraded', 'Outage')),
  CONSTRAINT service_status_history_source_check CHECK (source IN ('computed', 'stale', 'disabled', 'override'))
);
CREATE INDEX service_status_history_service_id_started_at_idx ON service_status_history(service_id, started_at);

CREATE TABLE status_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  ended_by_user_id UUID REFERENCES users(id),
  end_reason TEXT,
  CONSTRAINT status_overrides_status_check CHECK (status IN ('Unknown', 'Operational', 'Degraded', 'Outage')),
  CONSTRAINT status_overrides_reason_check CHECK (char_length(btrim(reason)) >= 3),
  CONSTRAINT status_overrides_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT status_overrides_end_reason_check CHECK (end_reason IN ('cancelled', 'expired')),
  CONSTRAINT status_overrides_end_consistent CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
-- One active override per service (SP-04.5). A new one is allowed once the previous has ended.
CREATE UNIQUE INDEX status_overrides_one_active_per_service_idx ON status_overrides(service_id) WHERE ended_at IS NULL;
CREATE INDEX status_overrides_active_expires_at_idx ON status_overrides(expires_at) WHERE ended_at IS NULL;

CREATE TABLE incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Investigating',
  origin TEXT NOT NULL,
  is_public BOOLEAN NOT NULL DEFAULT false,
  opened_by_user_id UUID REFERENCES users(id),
  resolved_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT incidents_status_check CHECK (status IN ('Investigating', 'Identified', 'Monitoring', 'Resolved')),
  CONSTRAINT incidents_origin_check CHECK (origin IN ('auto', 'manual')),
  CONSTRAINT incidents_resolved_consistent CHECK ((status = 'Resolved') = (resolved_at IS NOT NULL)),
  CONSTRAINT incidents_manual_has_opener CHECK (origin = 'auto' OR opened_by_user_id IS NOT NULL)
);
-- One active (non-resolved) incident per service (SP-05.2): the safety net when two workers race.
CREATE UNIQUE INDEX incidents_one_active_per_service_idx ON incidents(service_id) WHERE status <> 'Resolved';
CREATE INDEX incidents_project_id_created_at_idx ON incidents(project_id, created_at);
CREATE INDEX incidents_service_id_created_at_idx ON incidents(service_id, created_at);

CREATE TABLE incident_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  is_public BOOLEAN NOT NULL DEFAULT false,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT incident_updates_status_check CHECK (status IN ('Investigating', 'Identified', 'Monitoring', 'Resolved')),
  CONSTRAINT incident_updates_message_check CHECK (char_length(btrim(message)) BETWEEN 1 AND 2000)
);
CREATE INDEX incident_updates_incident_id_created_at_idx ON incident_updates(incident_id, created_at);

-- RLS: every new table, no policies, so the Supabase Data API cannot read rows
ALTER TABLE service_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE status_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_updates ENABLE ROW LEVEL SECURITY;
