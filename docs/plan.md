# Status Pulse: Task & Ownership Plan

> **Requirement: Task/ownership plan.** Status Pulse is a solo project, and every task is owned by the project's developer. Ownership is evidenced by the commit history, the decision log in this document and the automated tests. Presentation 1 covers Weeks 1 and 2.

## Milestones

| Week | Scope | Main tasks | Evidence |
|---|---|---|---|
| 1 | Requirements and architecture | Stories and criteria, user flows, architecture, data model, API draft, task plan | `docs/`, commit history |
| 2 | SP-01 to 03: accounts, projects, services, scheduler, worker, results | Implementation sequence below | Runnable API and worker, tests, API examples, deployed test environment |
| 3 | SP-04 to 05: status calculation, overrides, incidents | `evaluate` function with table-driven tests, thresholds, streak reset, sweeper (stale results, override expiry), per-service row lock, incident lifecycle, one-incident rule | Threshold and transition tests, updated API contract |
| 4 | SP-06 to 07: alerts, public pages, subscriptions, plans | Outbox and dispatcher with retry, acknowledgement, public routes with explicit response shapes, subscription and verification, idempotent plan upgrade, interface for the four roles | Deployed link, alert and payment evidence |
| 5 | SP-03 to 08: testing and reliability | Concurrency tests, permission matrix, retry tests, admin endpoints, audit completeness, setup documentation | Regression results, defect and fix log |
| 6 | Final delivery | Demonstration of registration, outage, alert retry, recovery and public update; reflection | Deployed demo, acceptance evidence |

## Implementation sequence for Weeks 1 and 2

Each step is a small set of related files, built and tested before it is committed.

| # | Step | Verifies |
|---|---|---|
| 1 | Single-package structure: TypeScript 6 compiled with `tsc` to `dist/`, scripts, `.gitignore` | The project builds and runs from one place |
| 2 | `core`: endpoint URL safety checks (private, loopback, link-local, IPv6 forms), with tests | SP-02.3 |
| 3 | `core`: epoch-aligned slots, credential encryption, password hashing, with tests | SP-03.1, SP-02.6, SP-01.1 |
| 4 | Prisma schema and first migration, including hand-written SQL for row level security; database client; test helper giving each test file an isolated schema | The data model runs on Supabase |
| 5 | API foundation: application factory, error envelope, request logging without query strings, configuration loading, Zod validation helper | Consistent errors, no secrets in logs |
| 6 | Authentication: registration, login, refresh-token rotation with reuse detection | SP-01.1, SP-01.2 |
| 7 | Projects, memberships and role checks, with a permission test over every route | SP-01.3 to 06 |
| 8 | Services: create and list, with validation, host resolution check, credential encryption, configuration versions and audit | SP-02.1 to 06 |
| 9 | Services: edit, disable, enable, delete | SP-02.4, SP-02.5 |
| 10 | Scheduler: one job per service per slot, stale jobs skipped | SP-03.1 |
| 11 | Worker: job claim with `SKIP LOCKED`, HTTP checker with timeout and connect-time address check, result storage | SP-03.2 to 05 |
| 12 | Results endpoint, launcher script, deployment configuration for Render, seed script for demonstration accounts | Deployed test environment |
| 13 | Documentation: README setup, API examples, stories and data model aligned with the implementation | Developer documentation |

Prioritisation: steps 10, 11 and 12 and all automated tests are required for Week 2. Step 9 and the host resolution check in step 8 can be deferred without affecting the Week 2 evidence.

## Decision log

| Decision | Alternatives considered | Reason |
|---|---|---|
| The database enforces every "exactly once" rule | Application-level checks | Application checks can race; database constraints cannot |
| PostgreSQL as the job queue | Redis, RabbitMQ | One fewer service to run, and constraints provide the guarantees |
| Epoch-aligned `scheduled_for` | `now()` timestamps | Several schedulers compute the same slot, so duplicates collide on one row |
| Four processes in one codebase | One process with timers; multiple packages | Real multi-worker behaviour with a single `package.json` |
| Alert dispatcher as a separate process | Sending alerts inside the worker | A failing mail provider cannot delay checks |
| Status calculated on write through one `evaluate` function | Calculated on every read | A change of status is an event, and the public page stays a cheap read |
| Per-service row lock around every status change | Optimistic version check | Simpler to implement and to reason about |
| Stale jobs are skipped, not caught up | Run every missed check | Catching up would record many identical results with false timestamps |
| A streak restarts when a service enters Unknown | Streak continues across a gap | Results from before a gap say nothing about the present |
| An override suppresses new incidents and alerts | Override changes only the displayed status | The owner has declared the status, and checks are still recorded |
| Incident visibility follows its service; the owner may hide an incident | Free choice per incident | An incident on a private service must never be public |
| Role read from the database on every request | Role stored in the token | A removed member loses access immediately |
| bcrypt at cost 12, passwords limited to 72 bytes | scrypt, Argon2id | OWASP lists bcrypt as the choice after Argon2id, and it is widely understood |
| Prisma for the model and ordinary queries; raw SQL for row locks, the claim query and the one-incident rule | Raw SQL only | Prisma cannot express row locks or partial unique indexes |
| TypeScript 6 compiled with `tsc`; Vitest | TypeScript 7; esbuild-based runners | esbuild 0.27 and later require macOS 12, and development is on macOS 11 |
| Render for the shared test environment | Other hosts | Deploys directly from the repository |

## Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Compressed schedule: Weeks 1 and 2 are assessed together | High | High | Fixed implementation sequence; tests and deployment prioritised over optional features |
| 2 | Design rationale is lost between work sessions | Med | High | Decision log, architecture document, and tests that act as an executable specification |
| 3 | Duplicate work under concurrency | Med | High | Database constraints, verified by tests against a real PostgreSQL |
| 4 | Status engine is late in Week 3, which carries 40% of the grade | Med | High | Rules kept as pure functions in `core` with table-driven tests, started early |
| 5 | Raw SQL bypasses Prisma's type checking | Med | Med | Raw queries kept in one module, each covered by a test |
| 6 | Server-side request forgery or credential leak | Low | High | Address checks at save and at connect time, encrypted credentials, explicit response shapes, logs without query strings |
| 7 | Supabase Data API exposes tables | Med | High | Row level security on every table, verified by a test |
| 8 | Free-tier limits: Supabase connections, Render idle sleep | Med | Med | Small connection pools; service woken before any demonstration |
| 9 | Tooling unsupported on macOS 11 | Med | Med | No esbuild-based tools; only tools verified on the development machine |
| 10 | Time-dependent tests are flaky | Med | Med | Injected clock; no direct `Date.now()` in logic |
| 11 | Scope creep into out-of-scope items | Low | Med | Non-goals listed in the README |

## Commit conventions

Conventional commits with a scope, one logical change per commit, and no unrelated changes bundled together. Each commit builds and its tests pass. Documents are committed one at a time.
