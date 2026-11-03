# SP-RAWH — Reflection and handover

**Project:** Status Pulse (API / workers) + StatusGrep (UI, https://statusgrep.vercel.app)

---

## 1. What was built

Status Pulse is an HTTP monitoring backend: accounts and projects, scheduled checks, status derivation, incidents and alerts, public status JSON, plan limits with Paystack, audit, and platform admin. StatusGrep is the operator UI that talks to the API with Bearer tokens.

**Processes:** API · scheduler · worker · dispatcher (shared Postgres; optional Redis for public status cache).

**Not in this repo:** long-running browser UI (moved to StatusGrep), SMS, multi-region runners, full APM.

---

## 2. Decisions

| Decision                                | Why                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Four processes, one DB                  | Isolates check latency and mail from the API; matches “worker must not block unrelated services.”  |
| Exactly-once via DB constraints         | Jobs, active incident per service, alert dedupe, payment idempotency keys — races resolved in SQL. |
| Outbox for email                        | Send failures must not roll back status/incident writes; retries are explicit.                     |
| UI split from API                       | CORS + Bearer; API stays JSON; UI can deploy on Vercel/Render independently.                       |
| Paystack initialize → checkout → verify | Plan must not flip on initialize alone.                                                            |
| Plan limits on create                   | Free/pro `maxServices` / `maxMembers` enforced when adding services and members.                   |
| Incident lifecycle one-way              | Investigating → Identified → Monitoring → Resolved only.                                           |

---

## 3. Reflection

- Core monitoring loop (schedule → check → status → incident) is coherent and tested heavily.
- Role model (Owner / Responder / Viewer) and 404-for-non-members are clear.
- Public vs private service boundary is enforced in the public API.
- Deployment of API + workers on Render is real, not local-only.

## 4. Limitations

- Single-region checks; no multi-probe consensus.
- Email is transactional only (outage, verify, public updates) — no invite/admin mails.
- Public “status page” in this repo is **JSON**; HTML public page lives in StatusGrep.
- Cache is best-effort (Redis with fallback).
- Strict rate limits only on auth/subscribe, not every route.

## 5. Run

1. Copy `.env.example` → `.env` (or set Render env).
2. `pnpm install` · `pnpm prisma:generate` · `pnpm prisma:migrate` · `pnpm build`.
3. `pnpm start:all` (or separate API / scheduler / worker / dispatcher).
4. Point StatusGrep `API_BASE_URL` at the API; set API `CORS_ORIGIN`.
5. Mail: `BREVO_API_KEY` + `MAIL_FROM` (verified). Payments: `PAYSTACK_SECRET_KEY`, `PAYSTACK_CURRENCY`.
6. OpenAPI: `/api/docs`. Health: `/health`.

**Do not** run `prisma migrate dev` against a data-holding DB because the project relies on hand-written partial unique indexes.
Only `prisma migrate deploy` / `pnpm prisma:migrate` should be ran.

## 6. Locations

| Concern                | Location                                                                   |
| ---------------------- | -------------------------------------------------------------------------- |
| HTTP surface           | `src/routes/*`, `src/doc/openapi.yaml`                                     |
| Status rules           | `src/core/status.ts`, `src/core/incident.ts`                               |
| Check pipeline         | `src/scheduler/*`, `src/worker/*`, `src/db/record-result.ts`               |
| Mail                   | `src/dispatcher/*`, `src/db/outbox.ts`, `src/db/incidents.ts` (alert rows) |
| Plans / Paystack       | `src/db/plans.ts`, `src/payments/paystack.ts`                              |
| Stories / criteria     | `docs/stories.md`                                                          |
| Architecture narrative | `docs/architecture.md`                                                     |
| Data model             | `docs/erd.md`                                                              |

## 7. Verify acceptance (scenarios 1–7)

See also `docs/ACCEPTANCE_EVIDENCE.md`:

1. Healthy check → Operational
2. Fail threshold → one outage + one alert
3. Recovery threshold → Operational
4. Retries do not duplicate results/alerts
5. Failed mail recorded and retried
6. Private service absent from public JSON
7. Failed payment keeps plan; success upgrades once
