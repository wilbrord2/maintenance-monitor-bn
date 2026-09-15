# Deployment

## Container image

The `Dockerfile` is a multi-stage build:

1. **deps** — `npm ci --omit=dev` (production dependencies only).
2. **build** — full install and `tsc` compile to `dist/`.
3. **runtime** — `node:22-alpine` with only `node_modules` (production), `dist/` and `package.json`; runs as the
   unprivileged `node` user under `tini` (correct signal handling), exposes `3000`, and has a `HEALTHCHECK` on
   `/api/v1/health/live`. No compilers, dev dependencies, tests or source are shipped.

Install scripts are skipped (`--ignore-scripts`); `argon2` loads its bundled prebuilt musl binary.

```bash
docker build -t maintenance-monitor-api:1.0.0 .
```

## Docker Compose

```bash
cp .env.example .env    # set POSTGRES_PASSWORD, JWT secrets, CORS_ORIGIN, MAIL_*, URLs, ADMIN_*
docker compose up -d --build
docker compose --profile seed run --rm seed      # once: create the initial ADMIN
docker compose logs -f api
```

Services:

| Service                    | Role                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `postgres`                 | PostgreSQL 16 with a named volume and `pg_isready` health check (not published to the host)     |
| `migrate`                  | One-shot `node dist/database/scripts/migrate.js run`; the API starts only after it succeeds     |
| `api`                      | The API; read-only root filesystem, `tmpfs /tmp`, all capabilities dropped, `no-new-privileges` |
| `seed` (profile `seed`)    | One-shot initial ADMIN creation from `ADMIN_*`                                                  |
| `mailpit` (profile `mail`) | Local SMTP catcher (`MAIL_HOST=mailpit`, `MAIL_PORT=1025`, UI on `:8025`)                       |

## Production checklist

- [ ] `NODE_ENV=production`.
- [ ] Unique, random `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` (≥ 48 bytes) from a secret manager; rotate by
      deploying new secrets (all sessions end).
- [ ] `CORS_ORIGIN` lists exact frontend origins.
- [ ] TLS terminated at a reverse proxy/load balancer; `TRUST_PROXY` set to the number of proxy hops; cookies are
      `Secure` by default.
- [ ] `DATABASE_SSL=true` for managed databases; a least-privilege database user for the API.
- [ ] Company SMTP credentials configured; `GET /api/v1/health` reports `email: up`.
- [ ] `PASSWORD_RESET_URL` and `APP_LOGIN_URL` point to the production frontend.
- [ ] Swagger disabled, or enabled with `SWAGGER_USERNAME`/`SWAGGER_PASSWORD`.
- [ ] Migrations run as a separate step before new API instances start (never `synchronize`).
- [ ] Argon2 cost tuned so hashing takes roughly 100–300 ms on production hardware.
- [ ] Log shipping for JSON logs (`requestId` correlates API logs with audit entries).
- [ ] PostgreSQL backups with point-in-time recovery; periodic restore tests.
- [ ] Monitoring/alerting on `/api/v1/health` (503 = database down, `degraded` = email down).

## Release procedure

1. Build and push the image.
2. Run migrations with the new image (`migrate` service or `node dist/database/scripts/migrate.js run`). Write
   migrations to be backward compatible with the previous release during rolling updates.
3. Roll out API instances. On `SIGTERM` the server stops accepting connections, disconnects WebSocket clients,
   finishes in-flight requests, closes the database pool and exits (forced after 15 s).
4. Roll back by redeploying the previous image; revert a migration only if it is not backward compatible
   (`migrate.js revert`).

## Scaling out

The API is stateless apart from two per-process components; adjust them before running several replicas:

| Component         | Single instance      | Multiple replicas                                                                                                                         |
| ----------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Rate limiting     | In-memory store      | Use a shared store (e.g. `rate-limit-redis`) so limits apply across replicas. Account lockout is already database-backed.                 |
| Live status board | In-process broadcast | Install `@socket.io/redis-adapter` on the Socket.IO server and enable sticky sessions (or WebSocket-only transport) at the load balancer. |
| Token cleanup job | Hourly               | Safe to run on every replica (idempotent deletes).                                                                                        |

Database connections: total = replicas × `DATABASE_POOL_MAX`; keep it below the server's `max_connections`
(or use PgBouncer in transaction mode).

## Running without Docker

```bash
npm ci
npm run build
NODE_ENV=production node dist/database/scripts/migrate.js run
NODE_ENV=production node dist/database/scripts/seed.js      # first deployment only
NODE_ENV=production node dist/main.js
```

Run under a process manager (systemd, Kubernetes, ECS…) that sends `SIGTERM` and restarts on failure.
