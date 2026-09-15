# Maintenance Monitor API

Backend for **Maintenance Monitor**, a machine-fleet maintenance monitoring platform: live machine status,
maintenance/fault logs, machine history, technician activity, analytics, audit trail and a real-time status board.

Built with Node.js 22, Express 5, TypeScript (strict), PostgreSQL, TypeORM, Zod, JWT, Argon2id and Socket.IO.

## Highlights

- **Machine status is owned by machine logs.** No endpoint accepts a status; every change happens in one
  transaction that locks the machine row, validates the transition, writes the log, updates the status and
  writes audit entries — or rolls back entirely. Stale updates return `409`.
- **Secure authentication:** short-lived access tokens bound to a revocable session, rotating refresh tokens
  with reuse detection, Argon2id, account lockout, rate limiting, emailed temporary credentials with forced
  password change, single-use password-reset tokens.
- **RBAC** (`ADMIN`, `TECHNICIAN`) declared per route and resolved from the database on every request.
- **Audit trail** for every security and data change, written atomically with the change, never containing secrets.
- **Live status board** over Socket.IO (`machine.status.updated`), published only after commit.
- **OpenAPI 3.1** generated from the same Zod schemas that validate requests, so docs cannot drift.
- 290 unit, integration, security and concurrency tests against a real PostgreSQL database.

## Quick start (local)

Prerequisites: Node.js ≥ 22.13, PostgreSQL ≥ 14, an SMTP server (e.g. [Mailpit](https://mailpit.axllent.org/) on port 1025).

```bash
npm ci
cp .env.example .env          # set DATABASE_URL, JWT secrets, MAIL_*, ADMIN_* …
createdb maintenance_monitor
npm run migration:run         # apply schema migrations
npm run seed                  # create the initial ADMIN from ADMIN_* variables
npm run dev                   # http://localhost:3000
```

- API base URL: `http://localhost:3000/api/v1`
- Swagger UI: `http://localhost:3000/api/docs` (raw document: `/api/docs/openapi.json`)
- Health: `GET /api/v1/health`

Generate JWT secrets with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

## Quick start (Docker)

```bash
cp .env.example .env                              # set POSTGRES_PASSWORD, JWT secrets, MAIL_*, ADMIN_*
docker compose up -d --build                      # postgres → migrate → api
docker compose --profile seed run --rm seed       # create the initial ADMIN
docker compose --profile mail up -d mailpit       # optional: SMTP catcher at http://localhost:8025
```

## Scripts

| Script                                                       | Purpose                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------- |
| `npm run dev`                                                | Run with live reload (tsx)                              |
| `npm run build` / `npm start`                                | Compile to `dist/` and run the compiled server          |
| `npm run typecheck` / `npm run lint`                         | Strict type check / ESLint (type-aware)                 |
| `npm test`                                                   | All tests (unit + integration; needs the test database) |
| `npm run test:unit` / `npm run test:integration`             | One project only                                        |
| `npm run test:cov`                                           | Tests with coverage thresholds                          |
| `npm run migration:run` / `:revert` / `:show`                | Manage migrations                                       |
| `npm run migration:check`                                    | Fail if entities and schema have drifted                |
| `npm run migration:generate -- src/database/migrations/Name` | Generate a migration from entity changes                |
| `npm run seed`                                               | Create the initial ADMIN (idempotent)                   |

## Project structure

```
src/
  auth/            login, refresh/rotation, logout, passwords, sessions, guards, token cleanup
  users/           users & technician onboarding, own profile
  machines/        machine master data (no status writes)
  machine-logs/    logs, status synchronisation, transition & log rules, downtime
  analytics/       fleet and log analytics with time ranges
  audit/           audit writer, sanitiser and read API
  notifications/   mail (SMTP + templates) and realtime (Socket.IO status board)
  health/          health & liveness
  common/          HTTP/route system, errors, validation, pagination, logging, events, utils
  config/          environment schema and typed configuration
  database/        data source, migrations, seeds, CLI scripts
  app.ts           Express application factory
  container.ts     composition root (dependency injection)
  main.ts          server bootstrap and graceful shutdown
test/
  integration/     HTTP + database tests, including transaction and concurrency tests
  security/        authentication, authorization and hardening tests
  helpers/         test app, factories, in-memory mail transport
docs/              architecture, database, auth, authorization, API, state rules, deployment, config, testing
```

## Documentation

| Document                                               | Contents                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)           | Modules, layers, request lifecycle, DI, events, extensibility |
| [docs/database.md](docs/database.md)                   | Schema, constraints, indexes, migrations                      |
| [docs/authentication.md](docs/authentication.md)       | Tokens, sessions, onboarding, password flows, lockout         |
| [docs/authorization.md](docs/authorization.md)         | Role/permission matrix                                        |
| [docs/api.md](docs/api.md)                             | Endpoints, envelopes, errors, pagination, WebSocket protocol  |
| [docs/state-transitions.md](docs/state-transitions.md) | Machine state rules, log rules, synchronisation & concurrency |
| [docs/configuration.md](docs/configuration.md)         | Environment variables                                         |
| [docs/deployment.md](docs/deployment.md)               | Docker, production checklist, scaling                         |
| [docs/testing.md](docs/testing.md)                     | Running and writing tests                                     |
