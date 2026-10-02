# Status Pulse: Task & Ownership Plan

> **Requirement: Task/ownership plan.** Solo project: every task is owned by one person. Ownership is evidenced by the commit history, the decision log below and the tests. Presentation 1 covers Weeks 1 and 2.

## Milestones

| Week | Scope | Main tasks | Evidence |
|---|---|---|---|
| 1 | Requirements and architecture | Stories and criteria, flows, architecture, data model, API draft, task plan | `docs/`, commit history |
| 2 | SP-01 to 03: accounts, projects, services, scheduler, worker, results | See the code batches below | Runnable API and worker, tests, API examples, deployed test environment |
| 3 | SP-04 to 05: status, overrides, incidents | `evaluate` function and its table-driven tests, thresholds, streak reset, sweeper (stale to Unknown, override expiry), row lock, incident lifecycle, one-incident rule | Threshold and transition tests, updated API contract |
| 4 | SP-06 to 07: alerts, public pages, subscriptions, plans | Outbox and dispatcher with retry, acknowledgement, public routes with explicit serializers, subscribe and verify, idempotent plan upgrade, thin UI for the four roles | Deployed link, alert and payment evidence |
| 5 | SP-03 to 08: testing and reliability | Concurrency tests, permission matrix, retry tests, admin endpoints, audit completeness, setup documentation | Regression results, defect and fix log |
| 6 | Final delivery | Demo of registration, outage, alert retry, recovery and public update; polish; reflection | Deployed demo, acceptance evidence |

## Week 1 and 2 code batches

Each batch is a few related files, is built and tested before it is committed, and becomes one commit. The documents come first, then the code.

| # | Batch | Proves |
|---|---|---|
| 1 | Restructure to a single package: remove `apps/` and `packages/`, TypeScript 6 with `tsc` to `dist/`, scripts, `.gitignore` | The project builds and runs from one place |
| 2 | `core`: URL safety checks (private, loopback, link-local, IPv6 forms) with tests | SP-02.3 |
| 3 | `core`: epoch-aligned slots, credential encryption, password hashing (bcrypt, 72-byte limit) with tests | SP-03.1, SP-02.6, SP-01.1 |
| 4 | Prisma schema and first migration, with hand-written SQL for row level security; database client and a test helper that gives each test file its own schema | The data model runs on Supabase |
| 5 | API foundation: app factory, error envelope, Morgan with path-only logging, config loading, Zod validation helper | Consistent errors, no secrets in logs |
| 6 | Auth: register, login, refresh with rotation and reuse detection | SP-01.1, SP-01.2 |
| 7 | Projects, memberships and role checks, plus a permission matrix test over every route | SP-01.3 to 06 |
| 8 | Services: create and list with validation, host resolution check, credential encryption, config versions, audit | SP-02.1 to 06 |
| 9 | Services: edit, disable, enable, delete | SP-02.4, SP-02.5 |
| 10 | Scheduler: one job per service per slot, stale jobs skipped | SP-03.1, no catch-up |
| 11 | Worker: claim with `SKIP LOCKED`, HTTP checker with timeout and connect-time address check, result storage | SP-03.2 to 05 |
| 12 | Results endpoint, launcher script, `render.yaml`, seed script for demo accounts | Deployed environment |
| 13 | Documentation: README setup, API examples, stories and ERD updated to match the code | Developer documentation |

If time runs short, cut in this order: batch 9, then the host resolution check in batch 8. Never cut tests, the deployment in batch 12, or batches 10 and 11, because they are the Week 2 evidence.

## Decision log

| Decision | Alternatives considered | Reason |
|---|---|---|
| The database enforces every "exactly once" rule | Application-level checks | Application checks race; constraints do not |
| Postgres as the job queue | Redis, RabbitMQ | One fewer service, and constraints give the guarantees |
| Epoch-aligned `scheduled_for` | `now()` timestamps | Several schedulers compute the same slot, so duplicates collide |
| Four processes, one codebase | One process with timers; many packages | Real multi-worker behaviour, with one `package.json` to explain |
| Dispatcher as its own process | Sending inside the worker | A failing mail provider must not delay checks |
| Status calculated on write, through one `evaluate` function | Calculated on every read | A change of status is an event; the public page stays a cheap read |
| Per-service row lock around every status change | Optimistic version check | Simpler to write and to explain |
| Stale jobs are skipped, not caught up | Run every missed check | Twenty identical "checked just now" results would be false history |
| A streak restarts when a service enters Unknown | Streak continues across a gap | Evidence from before a silence says nothing about now |
| An override suppresses new incidents and alerts | Override changes only the display | The owner has declared the status; checks are still recorded |
| Incident visibility follows its service; owner may hide one | Free choice per incident | A public incident on a private service makes no sense |
| Role read from the database on every request | Role in the token | A removed member loses access immediately |
| bcrypt at cost 12, 72-byte limit | scrypt, Argon2id | Easy to explain; Argon2id needs a native add-on |
| Prisma plus raw SQL for locking and the one-incident rule | Raw SQL only | Prisma cannot express row locks or partial unique indexes |
| TypeScript 6 with `tsc`, Vitest, no esbuild | TypeScript 7, tsx | Works on the development machine; esbuild no longer supports macOS 11 |
| Render for the shared test environment | Other hosts | Deploys straight from the repository |

## Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Presentation is the day this plan is written, with Week 2 code still to build | High | High | Fixed batch order, a cut list, tests and deployment protected |
| 2 | Code I cannot explain when asked | Med | High | Every batch is discussed before it is committed; each is explained in my own words |
| 3 | Duplicate work under concurrency | Med | High | Database constraints, tests against a real Postgres |
| 4 | Status engine slips in Week 3, which is 40% of the grade | Med | High | Pure `core` functions with table-driven tests, started early |
| 5 | Prisma cannot express locks and partial indexes | Certain | Med | Raw SQL for those few queries, kept in one place and tested |
| 6 | SSRF or credential leak | Low | High | Checks at save and at connect time, encrypted credentials, explicit response shapes, path-only logs |
| 7 | Supabase exposes tables through its Data API | Med | High | Row level security on every table, tested |
| 8 | Free-tier limits: Supabase connections, Render sleeping | Med | Med | Small connection pools, wake the service before any demo |
| 9 | Native-binary tooling failing on macOS 11 | Med | Med | No esbuild; only tools verified on the development machine |
| 10 | Flaky time-based tests | Med | Med | Injected clock; no direct `Date.now()` in logic |
| 11 | Scope creep into out-of-scope items | Low | Med | Non-goals listed in the README |

## Commit discipline

Conventional commits with a scope, one logical change each, and no unrelated changes bundled together. Each commit builds and its tests pass. The Week 1 documents are committed one at a time after review.
