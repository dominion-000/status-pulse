# Status Pulse

HTTP endpoint monitoring, incident communication and public status pages.

Four processes share one PostgreSQL database: **API**, **scheduler**, **worker**, and **dispatcher** (Week 4). Every “exactly once” rule is enforced by a database constraint.

Week 1 deliverables live in `docs/`. This repository implements **Week 2**: accounts, projects, services, scheduled checks, results.

## Requirements

- Node.js 22+
- pnpm 9+
- PostgreSQL 15+ (local or Supabase session pooler)

## Setup

```bash
cp .env.example .env
# Set DATABASE_URL, CREDENTIALS_ENC_KEY (openssl rand -base64 32), JWT_SECRET (≥32 chars)

pnpm install
pnpm approve-builds          # allow @prisma/engines + prisma install scripts (pnpm 10+)
pnpm install                 # re-run so engines download
pnpm prisma:generate         # writes src/generated/prisma
pnpm prisma:migrate:dev      # or prisma:migrate on a deployed DB
pnpm build
pnpm seed                    # demo@statuspulse.local / correct horse battery
```

Prisma 7 keeps the connection URL in `prisma.config.ts` (not in the schema). Client code is generated under `src/generated/prisma`.

## Run locally

```bash
# Separate terminals (or use the launcher)
pnpm start:api
pnpm start:scheduler
pnpm start:worker
```

Or all processes in one (shared-environment style):

```bash
pnpm start:all
```

## Tests

```bash
pnpm test          # unit tests (no DB required for core/)
pnpm typecheck
```

Integration tests against a real database are planned for Week 5 concurrency scenarios. Week 2 unit coverage includes URL safety, slots, password hashing, secrets, and request logging.

## API (Week 2)

Base URL: `http://localhost:3000`

| Method | Path                                  | Auth    | Description                     |
| ------ | ------------------------------------- | ------- | ------------------------------- |
| POST   | `/auth/register`                      | —       | Register (bcrypt cost 12)       |
| POST   | `/auth/login`                         | —       | Access + refresh tokens         |
| POST   | `/auth/refresh`                       | —       | Rotate refresh token            |
| GET    | `/projects`                           | Bearer  | List memberships                |
| POST   | `/projects`                           | Bearer  | Create project (caller = Owner) |
| GET    | `/projects/:id`                       | Bearer  | Project detail                  |
| POST   | `/projects/:id/members`               | Owner   | Invite Responder/Viewer         |
| GET    | `/projects/:id/members`               | Viewer+ | List members                    |
| POST   | `/projects/:id/services`              | Owner   | Create service                  |
| GET    | `/projects/:id/services`              | Viewer+ | List services                   |
| GET    | `/projects/:id/services/:sid`         | Viewer+ | Service detail                  |
| POST   | `/projects/:id/services/:sid/disable` | Owner   | Disable checks                  |
| POST   | `/projects/:id/services/:sid/enable`  | Owner   | Re-enable                       |
| GET    | `/projects/:id/services/:sid/results` | Viewer+ | Recent check results            |
| GET    | `/health`                             | —       | Liveness                        |
