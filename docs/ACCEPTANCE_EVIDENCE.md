# SP-5YT0 — Acceptance evidence (scenarios 1–7)

**Product:** Status Pulse (API) + StatusGrep (UI)  
**API:** https://status-pulse-ng8d.onrender.com  
**UI:** https://statusgrep.vercel.app
**OpenAPI:** `{API}/api/docs`  
**Date:** 2026-11-01

---

## Scenario 1 — Healthy endpoint → Operational

**Requirement:** Project owner registers a healthy endpoint; scheduled checks record results; service appears operational on its status page.

| Step | Action                                                               | Expected                                     |
| ---- | -------------------------------------------------------------------- | -------------------------------------------- |
| 1    | Sign up / sign in (StatusGrep)                                       | Session established                          |
| 2    | Create project                                                       | Project listed                               |
| 3    | Add service: `https://httpbin.org/status/200`, interval 60s, enabled | Service created, status Unknown then updates |
| 4    | Wait ≥ 1 check interval                                              | Check results with `passed: true`            |
| 5    | Service detail / project overview                                    | **Operational**                              |
| 6    | Optional: `GET /api/v1/projects/:id/services/:sid/status`            | `"current": "Operational"`                   |
| 7    | Optional public: set `isPublic`, open public page                    | Service shown healthy                        |

**Evidence:**

- UI: project + service Operational
- API: sample result JSON (`passed`, `statusCode: 200`)
- Notes:

---

## Scenario 2 — Failure threshold → one outage + one alert

**Requirement:** Endpoint fails the configured threshold; one outage state and one alert; no duplicate incidents for the same continuous outage.

| Step | Action                                                                         | Expected                                  |
| ---- | ------------------------------------------------------------------------------ | ----------------------------------------- |
| 1    | Service URL `https://httpbin.org/status/500` (or disable healthy, enable fail) | Checks fail                               |
| 2    | Wait until `failThreshold` consecutive failures (default 3)                    | Status **Outage**                         |
| 3    | Incidents list                                                                 | **One** open incident for that service    |
| 4    | Alerts list                                                                    | **One** alert for that outage             |
| 5    | Further failing checks while incident open                                     | No second active incident for same outage |

**Evidence:**

- Status Outage screenshot
- Single incident id
- Single alert id
- Notes:

---

## Scenario 3 — Recovery before Operational

**Requirement:** Successful recovery checks move the service through the configured recovery rule before Operational.

| Step | Action                                                   | Expected                                                          |
| ---- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| 1    | Service in Outage                                        | —                                                                 |
| 2    | Point URL back to 200 / enable healthy endpoint          | Passing checks                                                    |
| 3    | Observe across `recoveryThreshold` successes (default 2) | Does not flip Operational on first success alone if threshold > 1 |
| 4    | After enough passes                                      | **Operational**                                                   |
| 5    | Status history                                           | Transition path visible (Outage → … → Operational)                |

**Evidence:**

- Results showing consecutive `passed: true`
- Final Operational
- Notes:

---

## Scenario 4 — Scheduler / worker retry without duplicates

**Requirement:** Scheduler or worker retries a job; retry does not create duplicate check results or alerts.

| Step | Action                                                         | Expected                                                               |
| ---- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1    | Admin → jobs / failures (or DB `check_jobs`)                   | Jobs claimed with lease / retry metadata                               |
| 2    | Integration tests: concurrent workers / unique job constraints | Pass in CI                                                             |
| 3    | Live: one interval → one result row per successful claim       | `check_results.job_id` unique                                          |
| 4    | Sustained outage                                               | Still one open incident; alerts not duplicated per same incident+state |

**Evidence:**

- `pnpm test` (or CI) relevant cases green
- Optional: job id + single result
- Notes: DB unique constraints on jobs/results/alerts enforce “exactly once” behaviour

---

## Scenario 5 — Failed alert delivery recorded and retried

**Requirement:** Alert delivery fails; failure is recorded and retried without falsely marking delivered / acknowledged.

| Step | Action                                                        | Expected                                                     |
| ---- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| 1    | Trigger outage with Owner/Responder email                     | Outbox row `kind` alert                                      |
| 2    | Force failure (bad provider config) or observe prior failures | `last_error` set, `attempts` increase                        |
| 3    | Dispatcher retries with backoff                               | `next_attempt_at` advances; not `delivered_at` until success |
| 4    | Acknowledge in UI                                             | Acknowledgement row; independent of delivery success         |
| 5    | After Brevo/Resend success                                    | `delivered_at` set                                           |

**Evidence:**

- Admin outbox or DB: attempts, last_error, delivered_at null then set
- Alert still acknowledgeable
- Notes:

---

## Scenario 6 — Private service hidden from public

**Requirement:** Private service hidden from public viewers and inaccessible outside the project.

| Step | Action                                   | Expected                           |
| ---- | ---------------------------------------- | ---------------------------------- |
| 1    | Service `isPublic: false`                | Default for new services           |
| 2    | `GET /api/v1/public/:slug`               | Service **absent** from `services` |
| 3    | Public status UI for slug                | Not listed                         |
| 4    | Logged-in member                         | Can see service in project UI      |
| 5    | Non-member API access to project service | 404 / forbidden per API rules      |

**Evidence:**

- Public JSON without private service
- Member UI shows it
- Notes:

---

## Scenario 7 — Plan payment: fail keeps limits; success once

**Requirement:** Failed plan payment leaves limits unchanged; successful path activates the plan exactly once (idempotent key).

| Step | Action                                                 | Expected                                        |
| ---- | ------------------------------------------------------ | ----------------------------------------------- |
| 1    | Project on **free** (new project if already pro)       | Limits: 3 services / 3 members (seed)           |
| 2    | Upgrade with Paystack **test** keys; complete checkout | Redirect → pay → callback → **pro**             |
| 3    | `GET .../plans`                                        | `current.name`: pro; higher limits              |
| 4    | Same Idempotency-Key replay                            | No double charge logic; stable outcome          |
| 5    | Optional: `PAYMENT_FAIL_ALL` or abandon checkout       | Plan stays free; payment attempt failed/pending |

**Currency:** amount is `plans.price_cents` in **minor units**.

**Evidence:**

- Free project before
- Paystack checkout screenshot
- Pro after verify
- Notes:

---

## Traceability

| Scenario | Main mechanisms                                                            |
| -------- | -------------------------------------------------------------------------- |
| 1–3      | Scheduler → worker → `check_results` → status rules → history              |
| 2, 4     | Partial unique indexes / job identity; one active incident per service     |
| 5        | Outbox + dispatcher attempts / backoff                                     |
| 6        | `is_public` on services; public route filters                              |
| 7        | Paystack initialize → checkout → verify → `payment_attempts` + plan update |

## Demo accounts / setup

- Owner email used in live demo:
- Admin (if shown):
- Env: Paystack test keys, mail provider

## Sign-off

| Item                                                   | Done |
| ------------------------------------------------------ | ---- |
| Scenarios 1–7 exercised on deployed environment        | []   |
| Screenshots or API captures attached / linked          | []   |
| Known limitations noted (e.g. mail domain, test cards) | []   |
