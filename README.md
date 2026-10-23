# Status Pulse

HTTP endpoint monitoring, incident communication and public status pages.

A service is checked on a schedule. Each result feeds a status calculation. A service that goes down opens an incident and raises an alert for the team. A public page shows the services and incidents an owner chose to publish, and verified subscribers are notified of public incident updates. Every "exactly once" rule is enforced by a database constraint, not by application code alone.

## Processes

Four processes share one PostgreSQL database.

| Process    | Entry                    | Responsibility                                                                                            |
| ---------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| API        | `src/main.ts`            | JSON API under `/api/v1`, browser UI, public status page                                                  |
| Scheduler  | `src/scheduler/main.ts`  | Enqueues one check job per service per interval, ends expired overrides, marks stale services Unknown     |
| Worker     | `src/worker/main.ts`     | Claims a job, runs the check, records the result, recalculates the status and opens an incident on outage |
| Dispatcher | `src/dispatcher/main.ts` | Claims outbox messages, sends them (simulated), retries failures with backoff                             |

Design rules, with the reasoning, are in `docs/architecture.md`. The data model is in `docs/erd.md`.

## Requirements

- Node.js 22 or later
- pnpm 12
- PostgreSQL 15 or later, local or hosted

## Setup

```bash
cp .env.example .env
# Set DATABASE_URL, CREDENTIALS_ENC_KEY (openssl rand -base64 32) and JWT_SECRET (at least 32 characters)

pnpm install
pnpm prisma:generate
pnpm prisma:migrate
pnpm build
pnpm seed
```

Migrations are hand-written SQL in `prisma/migrations`, because partial unique indexes cannot be expressed in `schema.prisma`. Apply them with `pnpm prisma:migrate` (`prisma migrate deploy`) only. `prisma migrate dev` must not be run against a database that holds data: it may try to drop those indexes.

`pnpm seed` creates the account `demo@statuspulse.local` (password `correct horse battery`), a project with the slug `demo` and one public service.

## Run

All four processes:

```bash
pnpm start:all
```

Or one by one:

```bash
pnpm start:api
pnpm start:scheduler
pnpm start:worker
pnpm start:dispatcher
```

The API listens on `PORT` (default 3000).

| Address                | Content                                                                           |
| ---------------------- | --------------------------------------------------------------------------------- |
| `/app/login`           | Browser UI for owners and responders: projects, services, incidents, alerts, plan |
| `/status/:slug`        | Public status page of a project, with a subscribe form                            |
| `/api/v1/...`          | JSON API, described in `docs/openapi.yaml`                                        |
| `/api/v1/public/:slug` | JSON of the public status page                                                    |
| `/health`              | Liveness check                                                                    |

## Roles

Roles are ordered Owner, Responder, Viewer. A caller who is not a member of a project receives `404`; a member whose role is too low receives `403`.

| Role      | Can                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Viewer    | Read services, results, status, incidents and members                                                                        |
| Responder | Everything a Viewer can, plus open and update incidents, view alerts, acknowledge them and retry delivery                    |
| Owner     | Everything a Responder can, plus create and edit services, set overrides, manage members, hide incidents and change the plan |

## Configuration

Values are read from the environment, and from `.env` through `dotenv`.

| Variable                    | Default  | Purpose                                                                                                    |
| --------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | required | PostgreSQL connection string                                                                               |
| `CREDENTIALS_ENC_KEY`       | required | 32 bytes, base64. Encrypts endpoint credentials with AES-256-GCM                                           |
| `JWT_SECRET`                | required | Signs access tokens. At least 32 characters                                                                |
| `PORT`                      | 3000     | API port                                                                                                   |
| `ACCESS_TOKEN_TTL_SECONDS`  | 28800    | Access token lifetime in seconds (8 hours). The browser session cookie uses the same value                 |
| `REFRESH_TOKEN_TTL_DAYS`    | 30       | Refresh token lifetime                                                                                     |
| `WORKER_LEASE_SECONDS`      | 60       | How long a claimed check job is reserved                                                                   |
| `WORKER_MAX_ATTEMPTS`       | 5        | Claim attempts before a job is abandoned                                                                   |
| `DISPATCHER_LEASE_SECONDS`  | 30       | How long a claimed outbox message is reserved                                                              |
| `DISPATCHER_MAX_ATTEMPTS`   | 6        | Automatic send attempts before a message waits for a manual retry                                          |
| `TRUST_PROXY_HOPS`          | 0        | Number of proxies in front of the API. Set to `1` behind Render: the rate limit keys on the client address |
| `EXPOSE_VERIFICATION_TOKEN` | see note | `1` returns the subscription verification token in the response and on the page, `0` never does            |
| `MAIL_FAIL_ALL`             | 0        | `1` makes every simulated send fail                                                                        |
| `PAYMENT_FAIL_ALL`          | 0        | `1` makes every simulated payment fail                                                                     |
| `RATE_LIMIT_DISABLED`       | unset    | `1` switches rate limiting off. Meant for rehearsals; the API logs a warning at start while it is set      |
| `DATABASE_URL_TEST`         | none     | A separate database for the tests (see Tests)                                                              |

`EXPOSE_VERIFICATION_TOKEN`: unset, the token is returned outside production and withheld when `NODE_ENV=production`. The token proves control of the mailbox, so returning it defeats the check. It belongs only in a demonstration, where no mailbox exists. The token is always in the simulated verification message.

Rate limiting applies to register, login and subscribe, in the API and in the browser forms. Register and login (API and browser) share one limit; subscribe (API and browser) has its own, so flooding one flow does not lock out the other. Each limit is 20 requests per hour per client address, held in the memory of one process. The address is `req.ip`, never the `X-Forwarded-For` header, which a client can write.

## Plans

Every project starts on the free plan. A plan sets the most services and members a project can hold, and the limits apply everywhere a service is created or a member is added, in the API and in the browser alike. A request over the limit is refused with `409`. Services that were deleted do not count; the owner counts as a member.

| Plan | Services | Members |
| ---- | -------- | ------- |
| free | 3        | 3       |
| pro  | 50       | 20      |

Switching to a plan whose limits are below what the project already has is refused with `409`; nothing is recorded, so the same `Idempotency-Key` can be used again after the project has been reduced. The limits are stored in the `plans` table; the pro plan costs $20.00.

## Simulated delivery

No real mail or payment provider is used.

- A message to an address on `fail.example` always fails. The dispatcher records the error, retries with backoff of 5 s, 10 s, 20 s and so on up to 5 minutes, and stops after `DISPATCHER_MAX_ATTEMPTS` until an alert's retry is requested.
- `MAIL_FAIL_ALL=1` fails every send.
- `PAYMENT_FAIL_ALL=1` fails every plan upgrade. The failed attempt is recorded, the plan stays unchanged, and the same `Idempotency-Key` keeps answering with that failure.

## Tests

```bash
pnpm typecheck
pnpm test
```

Most tests run against a real PostgreSQL, because they exercise unique indexes, CHECK constraints, row locks and cascades. Each test file builds its own schema from the real migration files and drops it afterwards. Point `DATABASE_URL_TEST` at a database that holds nothing of value, set in the shell or in `.env`.

## Deployment

The launcher starts all four processes from one command.

| Setting       | Value                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------ |
| Build command | `pnpm install && pnpm prisma:generate && pnpm build`                                             |
| Start command | `pnpm start:all`                                                                                 |
| Health check  | `/health`                                                                                        |
| Environment   | `DATABASE_URL`, `CREDENTIALS_ENC_KEY`, `JWT_SECRET`, `NODE_ENV=production`, `TRUST_PROXY_HOPS=1` |

- The build needs the development dependencies: `typescript` compiles the code and `prisma` generates the client and applies migrations.
- `prisma:generate` needs `DATABASE_URL` to be set during the build; the value is not used to connect.
- Migrations are applied with `pnpm prisma:migrate` against the production database, once before the first start and again after each new migration.
- `TRUST_PROXY_HOPS=1` is required behind Render's proxy. Without it every visitor appears to come from the proxy's address, so all visitors share one rate-limit counter.
- A hosted PostgreSQL such as Supabase is used for `DATABASE_URL`.

## Documentation

| File                   | Content                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `docs/stories.md`      | Stories and acceptance criteria                                      |
| `docs/architecture.md` | Processes, status and incident rules, guarantees and their mechanism |
| `docs/erd.md`          | Data model and constraints                                           |
| `docs/flows.md`        | User flows for the four roles                                        |
| `docs/openapi.yaml`    | API contract                                                         |
| `docs/plan.md`         | Task and ownership plan                                              |
