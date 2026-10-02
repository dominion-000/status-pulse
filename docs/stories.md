# Status Pulse: Stories, Acceptance Criteria and Traceability

> **Requirement: Stories + criteria.** Each SP section has a story and numbered, testable criteria. The traceability table at the end maps requirements to the acceptance scenarios and to the tests that verify them.

## Roles

`Owner` (developer or project owner), `Responder` and `Viewer` are project roles. `Public` is an unauthenticated visitor or subscriber. `Admin` is a platform role.

## Delivery schedule

| Requirement | Subject | Delivered in |
|---|---|---|
| SP-01 | Accounts, projects, permissions | Week 2 |
| SP-02 | Service and check configuration | Week 2 |
| SP-03 | Scheduled health checks | Week 2 |
| SP-04 | Status calculation and history | Week 3 |
| SP-05 | Incidents and updates | Week 3 |
| SP-06 | Alerts and acknowledgement | Week 4 |
| SP-07 | Public status pages, subscriptions, plans | Week 4 |
| SP-08 | Reliability, audit, administration | Weeks 3 to 5 |

---

## SP-01: Accounts, projects and permissions

**Story.** As a developer, I register, create projects and invite team members with roles, so that people can access only what they are assigned.

| ID | Criterion |
|---|---|
| SP-01.1 | Registration stores a bcrypt hash (cost 12) of the password. Passwords longer than 72 bytes are rejected with `422`. A duplicate email returns `409`. |
| SP-01.2 | Login returns an access token and a refresh token. Refresh tokens are stored hashed and replaced on every use. |
| SP-01.3 | Creating a project makes the caller its `Owner`. |
| SP-01.4 | Only an `Owner` can invite members or change roles. |
| SP-01.5 | The caller's role is read from the memberships table on every request, never from the token, so a removed or changed role takes effect immediately. |
| SP-01.6 | A non-member requesting a project resource receives `404`. A member with an insufficient role receives `403`. |
| SP-01.7 | An expired access token is refused with `401`. A valid refresh token returns a new pair, and an expired or already-used refresh token is refused, with the user's other sessions revoked in the already-used case. |

## SP-02: Service and check configuration

**Story.** As an owner, I register and maintain services with validated check settings, so that invalid or unsafe configuration never runs.

| ID | Criterion |
|---|---|
| SP-02.1 | A service stores a name, URL, method, interval, timeout, expected response (status codes and optional body text) and a public or private setting. The default is private. |
| SP-02.2 | Invalid URLs, schemes other than http and https, unsupported intervals and `timeout >= interval` are rejected with `422` and a structured `details` list. |
| SP-02.3 | Hosts that are private, loopback or link-local are rejected when the service is saved and again when the worker connects. Redirects are not followed. |
| SP-02.4 | Every configuration change creates a `service_config_versions` row with the actor and timestamp. |
| SP-02.5 | Disabled or deleted services never produce scheduled checks. |
| SP-02.6 | Endpoint credentials are encrypted at rest and never appear in a response or a log. |
| SP-02.7 | The owner sets the thresholds: consecutive failures for an outage, consecutive passes for recovery, a latency limit for a slow result, and the number of consecutive slow results that make a service degraded. Defaults apply when they are omitted. |
| SP-02.8 | An edit is validated as a complete configuration, not field by field, and creates a new version. |
| SP-02.9 | A disabled service shows `Unknown` and is hidden from the public page. Re-enabling it resumes checks. |

## SP-03: Scheduled health checks

**Story.** As the system, I dispatch each due check exactly once, even with several workers, so that history is accurate and no service is starved.

| ID | Criterion |
|---|---|
| SP-03.1 | `UNIQUE (service_id, scheduled_for)` on epoch-aligned slots: any number of schedulers produces one job per service per slot. |
| SP-03.2 | Workers claim jobs with `FOR UPDATE SKIP LOCKED` and a lease. When a lease expires, the job can be claimed again. |
| SP-03.3 | `UNIQUE (job_id)` on `check_results`: a retried job never creates a second result. |
| SP-03.4 | A result records the status code, latency and timestamp, and a failure reason when the check fails. |
| SP-03.5 | Each check runs under a hard timeout, so a slow endpoint cannot block checks of other services. |
| SP-03.6 | A newly created service is checked within seconds, without waiting for a full interval. |
| SP-03.7 | A job whose slot has passed is skipped, not run. After downtime, one current check runs and the normal interval resumes, with no backlog of missed checks. |

## SP-04: Status calculation and history

**Story.** As a viewer, I see each service's state derived from recent results, so that I know whether it is healthy.

| ID | Criterion |
|---|---|
| SP-04.1 | The states are `Operational`, `Degraded`, `Outage` and `Unknown`, derived from consecutive-result thresholds. |
| SP-04.2 | `Outage` requires the service's failure threshold of consecutive failures. `Degraded` requires its slow threshold of consecutive slow results. |
| SP-04.3 | Recovery steps from `Outage` to `Degraded` to `Operational`, each step after the recovery threshold of consecutive passes. |
| SP-04.4 | Raw results and derived status transitions are stored separately, and both can be queried. |
| SP-04.5 | An override requires a reason and an expiry, writes an audit row, and the computed status resumes at expiry or when the override is cancelled. |
| SP-04.6 | A service with no result within three intervals, or no result at all, is `Unknown`. |
| SP-04.7 | From `Unknown`, a first passing result gives `Operational`. Entering `Unknown` restarts all streaks, so earlier results are not counted. |
| SP-04.8 | While an override is active, results are still recorded, but no new incident or alert is created. An incident that is already open is unchanged. |

## SP-05: Incidents and updates

**Story.** As a responder, I run an incident through its lifecycle and publish updates, so that users know what is happening.

| ID | Criterion |
|---|---|
| SP-05.1 | An outage opens an incident automatically when no override is active. A responder can also open one manually. |
| SP-05.2 | At most one active (non-resolved) incident exists per service, enforced by a partial unique index. |
| SP-05.3 | Status moves `Investigating`, `Identified`, `Monitoring`, `Resolved`, in that order only. Any other transition returns `409`. |
| SP-05.4 | Updates are timestamped and record the actor. Each update is public or internal. |
| SP-05.5 | An incident takes its service's public or private setting. An incident on a private service is never public. The owner may hide an incident of a public service. Internal updates, and every update of a non-public incident, never appear on the status page. |
| SP-05.6 | Only a responder resolves an incident. The system never resolves one automatically. |

## SP-06: Alerts and acknowledgement

**Story.** As a responder, I receive one alert per problem, and a delivery counts as delivered only if it succeeded.

| ID | Criterion |
|---|---|
| SP-06.1 | A simulated email or in-app alert is created when a service enters a configured problem state. |
| SP-06.2 | `UNIQUE (service_id, incident_id, state)` prevents duplicate alerts for the same problem. |
| SP-06.3 | A failed delivery leaves `delivered_at` null, increments `attempts` and remains retryable. |
| SP-06.4 | Acknowledgement records the actor and timestamp, is idempotent, and never marks an alert as delivered. |
| SP-06.5 | A separate dispatcher process makes deliveries and retries failures with backoff, so a delivery failure never delays checks. |

## SP-07: Public status pages, subscriptions and plans

**Story.** As a visitor, I see public status and subscribe to services. As an owner, I control visibility and plan.

| ID | Criterion |
|---|---|
| SP-07.1 | The public page shows only services and incidents that are public: current status, active incidents and recent history. |
| SP-07.2 | Endpoint credentials, team details and internal notes never appear in a public response. |
| SP-07.3 | Subscribing to a public service requires simulated email verification. A repeated subscription creates no duplicate. |
| SP-07.4 | A plan upgrade requires an `Idempotency-Key`. A failed simulated payment leaves the plan limits unchanged. |
| SP-07.5 | A successful retry with the same key activates the plan exactly once. The same key with a different body returns `422`. |

## SP-08: Reliability, audit and administration

**Story.** As an administrator, I review failures and history, so that I can diagnose problems.

| ID | Criterion |
|---|---|
| SP-08.1 | Admin-only endpoints list scheduler failures, worker retries, failed alert deliveries and access changes. |
| SP-08.2 | The audit trail records the actor and timestamp for configuration, incident, acknowledgement, override, role and plan changes. |
| SP-08.3 | A service with stale or missing results shows `Unknown` and never stays `Operational`. |
| SP-08.4 | Non-admins receive `403` on admin endpoints. |

---

## Traceability: requirement, scenario, test

| Scenario | SP requirements | Criteria exercised | Test |
|---|---|---|---|
| 1. Successful monitoring | 01, 02, 03, 04, 07 | 01.3, 02.1, 03.4, 03.6, 04.7, 07.1 | Register an endpoint, checks run, the service shows `Operational` on the public page |
| 2. Threshold-based alerting | 04, 05, 06 | 04.2, 05.1, 05.2, 06.2 | The failure threshold is reached: exactly one outage, one incident and one alert |
| 3. Recovery rules | 04 | 04.3 | The recovery threshold of passes steps Outage, Degraded, Operational; fewer passes do not |
| 4. Idempotent workers | 03, 06 | 03.1, 03.2, 03.3, 03.7, 06.2 | Several schedulers give one job per slot; the same job processed twice gives one result and no duplicate alert |
| 5. Alert retries | 06 | 06.3, 06.4, 06.5 | A forced delivery failure leaves `delivered_at` null and the alert unacknowledged; the retry succeeds |
| 6. Data privacy | 01, 07 | 01.6, 05.5, 07.1, 07.2 | A private service is absent from the public API; an outsider receives `404` |
| 7. Plan upgrades | 07 | 07.4, 07.5 | A failed payment leaves limits unchanged; a retry with the same key activates the plan once |

## Cross-cutting tests

| Concern | Test |
|---|---|
| Permissions | For every route: no token gives `401`, a wrong role gives `403`, a non-member gives `404` |
| Address safety | `127.0.0.1`, `169.254.169.254`, IPv6 forms and a host name resolving to a private address are all rejected |
| Timeout isolation | An endpoint that never responds does not delay checks of other services |
| Downtime | Twenty queued stale jobs result in one check |
| Status race | An override and a check result arriving together produce a consistent outcome |
| Time | Thresholds, staleness and override expiry are tested with an injected clock |
| Secrets in logs | Request logs omit query strings, request bodies and authorization headers |

## Non-goals (v1.0)

Full application performance monitoring, log aggregation, infrastructure agents, SMS and telephone paging, real payment processing, multi-region runners, automatic remediation, custom domains and DNS management.
