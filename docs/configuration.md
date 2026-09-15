# Configuration

All configuration comes from environment variables, validated at startup by `src/config/env.schema.ts`.
Invalid configuration stops the process with a list of offending variable **names** (values are never printed).
For local development a `.env` file is loaded automatically; in production inject real environment variables or
secrets. `.env` is git-ignored — start from `.env.example`.

## Application

| Variable          | Default       | Description                                                                                                                                            |
| ----------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`        | `development` | `development`, `test` or `production`                                                                                                                  |
| `PORT`            | `3000`        | HTTP port                                                                                                                                              |
| `LOG_LEVEL`       | `info`        | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`                                                                                           |
| `TRUST_PROXY`     | `false`       | Express `trust proxy`: `true`, hop count (e.g. `1`) or subnet list. Set correctly behind a load balancer so client IPs (rate limiting, audit) are real |
| `CORS_ORIGIN`     | **required**  | Comma-separated allowed browser origins. `*` is rejected in production                                                                                 |
| `BODY_SIZE_LIMIT` | `100kb`       | Maximum JSON body size                                                                                                                                 |

## Database

| Variable                           | Default | Description                                                      |
| ---------------------------------- | ------- | ---------------------------------------------------------------- |
| `DATABASE_URL`                     | —       | `postgres://user:password@host:5432/database` (takes precedence) |
| `DATABASE_HOST`                    | —       | Used with the values below when `DATABASE_URL` is not set        |
| `DATABASE_PORT`                    | `5432`  |                                                                  |
| `DATABASE_USERNAME`                | —       | Percent-encoded automatically                                    |
| `DATABASE_PASSWORD`                | empty   | Percent-encoded automatically                                    |
| `DATABASE_NAME`                    | —       | Use a database dedicated to this application                     |
| `DATABASE_SSL`                     | `false` | Enable TLS to PostgreSQL                                         |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | `true`  | Verify the server certificate when SSL is on                     |
| `DATABASE_POOL_MAX`                | `10`    | Connection pool size per process                                 |
| `DATABASE_LOGGING`                 | `false` | Log SQL (development only — may include data)                    |

## JWT and sessions

| Variable                 | Default                       | Description                                                                 |
| ------------------------ | ----------------------------- | --------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`      | **required**                  | ≥ 32 characters; different from the refresh secret                          |
| `JWT_REFRESH_SECRET`     | **required**                  | ≥ 32 characters                                                             |
| `JWT_ACCESS_EXPIRES_IN`  | `15m`                         | Duration: `Ns`, `Nm`, `Nh`, `Nd`; must be shorter than the refresh lifetime |
| `JWT_REFRESH_EXPIRES_IN` | `7d`                          | Refresh token lifetime (renewed on each rotation)                           |
| `JWT_ISSUER`             | `maintenance-monitor`         | `iss` claim                                                                 |
| `JWT_AUDIENCE`           | `maintenance-monitor-clients` | `aud` claim                                                                 |
| `REFRESH_COOKIE_NAME`    | `mm_refresh_token`            | httpOnly refresh cookie name                                                |
| `COOKIE_SECURE`          | `true` in production          | Send the cookie over HTTPS only                                             |

## Password hashing and authentication policy

| Variable                     | Default       | Description                                       |
| ---------------------------- | ------------- | ------------------------------------------------- |
| `ARGON2_MEMORY_COST`         | `19456` (KiB) | Argon2id memory                                   |
| `ARGON2_TIME_COST`           | `2`           | Argon2id iterations                               |
| `ARGON2_PARALLELISM`         | `1`           | Argon2id lanes                                    |
| `LOGIN_MAX_ATTEMPTS`         | `5`           | Failures before lockout                           |
| `LOGIN_LOCK_MINUTES`         | `15`          | Lockout duration                                  |
| `TEMP_PASSWORD_TTL_HOURS`    | `72`          | Validity of emailed temporary credentials         |
| `PASSWORD_RESET_TTL_MINUTES` | `30`          | Validity of reset links                           |
| `PASSWORD_RESET_URL`         | **required**  | Frontend page receiving `?token=`                 |
| `APP_LOGIN_URL`              | **required**  | Frontend login page linked from onboarding emails |

## Company email (SMTP)

| Variable                          | Default               | Description                              |
| --------------------------------- | --------------------- | ---------------------------------------- |
| `MAIL_HOST`                       | **required**          | SMTP host                                |
| `MAIL_PORT`                       | **required**          | `587` (STARTTLS) or `465` (implicit TLS) |
| `MAIL_SECURE`                     | `false`               | `true` for implicit TLS (port 465)       |
| `MAIL_USERNAME` / `MAIL_PASSWORD` | —                     | Provide both or neither                  |
| `MAIL_FROM`                       | **required**          | Sender address                           |
| `MAIL_FROM_NAME`                  | `Maintenance Monitor` | Sender display name                      |

TLS 1.2+ is enforced when the server offers TLS.

### Using Gmail

Gmail's SMTP server works with the existing SMTP transport; no code changes are needed.

1. Use a dedicated Google account for the application (for example `maintenance.monitor@gmail.com`, or a Google
   Workspace mailbox on your company domain) rather than a personal inbox.
2. Turn on **2-Step Verification** for that account, then create an **App Password**
   (Google Account → Security → App passwords). Your normal Google password will not work over SMTP.
3. Configure:

   ```dotenv
   MAIL_HOST=
   MAIL_PORT=
   MAIL_SECURE=true
   MAIL_USERNAME=maintenance.monitor@gmail.com
   # The 16-character App Password, without spaces
   MAIL_PASSWORD=
   MAIL_FROM=maintenance.monitor@gmail.com
   MAIL_FROM_NAME=Maintenance Monitor
   ```

   Port `587` with `MAIL_SECURE=false` (STARTTLS) also works.

4. Restart the API and check `GET /api/v1/health`: `checks.email.status` should be `up`.

Notes:

- `MAIL_FROM` must be the Gmail address (or an alias verified under Gmail "Send mail as"); otherwise Gmail rewrites
  the sender.
- Sending limits are roughly 500 recipients/day for a free Gmail account and about 2,000/day for Google Workspace —
  far above what onboarding and password-reset emails need.
- An App Password grants access to the whole mailbox: keep it only in environment variables or a secret manager, and
  revoke it in the Google Account if it leaks. Google Workspace administrators can disable App Passwords.
- For production at scale or branded sending, a Google Workspace mailbox on your domain or a transactional provider
  (Amazon SES, Postmark, SendGrid, Mailgun) is more reliable; they are configured through the same `MAIL_*` variables.

## Rate limiting

| Variable                                  | Default         | Description                                                      |
| ----------------------------------------- | --------------- | ---------------------------------------------------------------- |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `60000` / `300` | Global limit per IP                                              |
| `AUTH_RATE_LIMIT_WINDOW_MS`               | `900000`        | Window for authentication limits                                 |
| `AUTH_RATE_LIMIT_MAX`                     | `20`            | Login attempts per IP+email per window (per-IP auth limit is 5×) |
| `FORGOT_PASSWORD_RATE_LIMIT_MAX`          | `5`             | Forgot/reset requests per IP per window                          |

## Swagger

| Variable                                | Default                                          | Description                                                                           |
| --------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `SWAGGER_ENABLED`                       | `true` outside production, `false` in production | Serve `/api/docs`                                                                     |
| `SWAGGER_USERNAME` / `SWAGGER_PASSWORD` | —                                                | HTTP Basic credentials; **required** when enabled in production (password ≥ 12 chars) |

## Seed (initial administrator)

Read only by `npm run seed` / the `seed` compose service.

| Variable         | Description                                                                  |
| ---------------- | ---------------------------------------------------------------------------- |
| `ADMIN_EMAIL`    | Administrator email                                                          |
| `ADMIN_PASSWORD` | 12+ characters with upper-case, lower-case and a digit; hashed with Argon2id |
| `ADMIN_NAME`     | Display name                                                                 |
| `ADMIN_PHONE`    | Phone (9–15 digits, optional leading `+`)                                    |

## Docker Compose

| Variable                              | Default               | Description                                                   |
| ------------------------------------- | --------------------- | ------------------------------------------------------------- |
| `POSTGRES_DB`                         | `maintenance_monitor` | Database created in the container                             |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` | **required**          | Database credentials; compose builds `DATABASE_URL` from them |
| `API_PORT`                            | `3000`                | Host port for the API                                         |
