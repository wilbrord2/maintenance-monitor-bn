# Testing

Jest (with `ts-jest`, type-checked) in two projects:

| Project       | Location                                                      | Needs a database | What it covers                                                                                              |
| ------------- | ------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `unit`        | `src/**/*.spec.ts` (next to the code)                         | No               | Services with mocked repositories, policies, token service, crypto, sanitiser, config, event bus, templates |
| `integration` | `test/integration/**/*.test.ts`, `test/security/**/*.test.ts` | Yes              | Real HTTP server + PostgreSQL + Socket.IO, full container wiring                                            |

## Setup

1. Create a disposable database whose name contains `test` (the suite refuses to run otherwise):
   ```bash
   createdb maintenance_monitor_test
   ```
2. Settings come from `.env.test` (non-secret test values). Override `DATABASE_URL` in the shell if needed:
   ```bash
   DATABASE_URL=postgres://user:pass@localhost:5432/maintenance_monitor_test npm test
   ```
   Migrations are applied automatically before the integration project (`test/helpers/global-setup.ts`).

## Commands

```bash
npm test                    # everything (serial: integration suites share one database)
npm run test:unit           # fast, no database
npm run test:integration    # database-backed suites
npm run test:cov            # with coverage; fails below 90% statements/lines/functions, 80% branches
```

No SMTP server is needed: tests inject `InMemoryMailTransport` and read temporary passwords and reset links from
captured emails.

## Suites

| Area                                   | Files                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication                         | `auth.service.spec.ts`, `token.service.spec.ts`, `password.service.spec.ts`, `test/integration/auth.test.ts` (login, refresh rotation, logout, onboarding, change/forgot/reset password)                                                                                                                                                                                                   |
| Users                                  | `users.service.spec.ts`, `test/integration/users.test.ts`                                                                                                                                                                                                                                                                                                                                  |
| Machines                               | `machines.service.spec.ts`, `test/integration/machines.test.ts`                                                                                                                                                                                                                                                                                                                            |
| Machine logs                           | `machine-logs.service.spec.ts`, policy specs, `test/integration/machine-logs.test.ts`                                                                                                                                                                                                                                                                                                      |
| **Critical transaction & concurrency** | `test/integration/machine-status-sync.test.ts` — failure injected after each write rolls back log + status + audit; 12 simultaneous conflicting requests → exactly one wins; concurrent version edits; DB constraints                                                                                                                                                                      |
| Analytics                              | `time-range.spec.ts`, `analytics.service.spec.ts`, `test/integration/analytics.test.ts`                                                                                                                                                                                                                                                                                                    |
| Audit                                  | `audit-sanitizer.spec.ts`, `test/integration/audit.test.ts` (every required action recorded, no secrets)                                                                                                                                                                                                                                                                                   |
| Real time                              | `test/integration/realtime.test.ts` (broadcast to multiple clients, auth, expiry disconnect)                                                                                                                                                                                                                                                                                               |
| Security                               | `test/security/auth-security.test.ts` (unauthorised access, role violations, expired/forged/tampered JWT, revoked and reused refresh tokens, inactive users, brute force, rate limits), `machine-status-protection.test.ts` (no direct status changes), `hardening.test.ts` (injection, 415, prototype pollution, control characters, generic 500s, log redaction, token cleanup, headers) |
| Platform                               | `test/integration/health.test.ts`, `platform.test.ts` (seed, Swagger basic auth, OpenAPI completeness)                                                                                                                                                                                                                                                                                     |

## Writing tests

- Build a context with `createTestContext({ env?, overrides? })`; it starts a real HTTP server on a random port with
  the production container. Close it in `afterAll` with `ctx.container.close()`.
- Call `resetDatabase(ctx.container)` in `beforeEach` for isolation.
- Use factories from `test/helpers/factories.ts`: `adminSession`, `technicianSession`, `createUser`, `createMachine`,
  `expectStatusMatchesLatestLog` (asserts the core status invariant).
- Inject failures through `ContainerOverrides` (e.g. a custom `auditService`) rather than mocking modules.
- Assert on `code` values, not messages, for error cases.

## Quality gates

Before merging:

```bash
npm run typecheck && npm run lint && npm run test:cov && npm run build && npm run migration:check
```
