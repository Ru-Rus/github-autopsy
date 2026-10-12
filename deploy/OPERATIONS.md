# Production operations

## Configuration and deployment

Copy `.env.example` to `.env`; use independent random URL-safe secrets (at least
32 characters), and a URL-safe database password. Never commit `.env`. Configure
HTTPS at the hosting ingress; Compose binds its HTTP entry point to loopback.
Run `docker compose config --quiet`, then `docker compose up --build --wait`.
Existing database volumes need `npm run db:migrate` with an operator database URL
before deploying a new schema. The initialization mount runs only on new volumes.
Use a dedicated runtime database role with SELECT/INSERT/UPDATE/DELETE on the
three autopsy tables; migrations use a separate owner. All application instances
must use the same database, proxy secret, GitHub token and AI configuration.

Never publish application or PostgreSQL ports. The trusted proxy overwrites both
identity headers and authenticates itself with the shared secret. Client-supplied
X-Forwarded-For is ignored by the application. Behind another ingress, the proxy
currently groups clients by that ingress's socket IP; configure an explicitly
trusted Nginx real-IP source before enabling finer identities. Do not trust all
source CIDRs. Quota reservations are conservative: 50 GitHub requests per uncached
analysis, 50/hour without token or 4,500/hour with token; 10 analyses/minute and
30 optional AI calls/hour, each with <=16KB input evidence and 1,800 output tokens.
Use a dedicated GitHub token and OpenAI project; external callers sharing those
credentials are outside these budgets. Provider rate errors still take precedence.

## Health, metrics and alerts

`GET /api/health/live` checks process responsiveness. `GET /api/health/ready`
checks database/schema and configuration. Readiness and `GET /api/metrics` require
`Authorization: Bearer <MONITORING_TOKEN>` and are blocked at the public proxy.
Scrape each instance over the private network every 15s; counters reset on restart.
Ship JSON stdout logs to centralized storage; no source, tokens, IPs or raw errors
are logged by application events. Set initial alert thresholds: readiness failure
for 60s; analysis_failed or snapshot_read_failed >5% over 5m; any sustained
database_connection_failed; snapshot_save_failed >0 for 5m; ai_review_unavailable

> 20% over 15m; database storage >80%; snapshots >=900; last backup age >26h.
> Assign an on-call owner and test delivery. Recommendations are not active alerts.

## Backup and restore

Back up daily using PostgreSQL `pg_dump --format=custom --file=autopsy.dump` with
PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD supplied through secret management.
Encrypt backups and copy them off-host; keep 7 daily and 4 weekly copies. Enable
managed PostgreSQL PITR/WAL archiving for an RPO below 24h. Target RTO: 30 minutes.
Run `pg_restore --exit-on-error --dbname=<isolated restore database> autopsy.dump`
against an EMPTY isolated database. Supply credentials via environment/secret
manager, never a URL in shell history. Start an isolated app using the restored
database and validate readiness, known snapshot hashes and indexed history.
Never restore over a serving database. To cut over: pause ingress, stop writers,
point app instances to the verified restored database, start and check readiness,
then reopen ingress. Record measured RPO/RTO and evidence quarterly. The local
automated test verifies logical snapshot restoration; it is not a pg_dump/PITR drill.

## Failures and rollback

Database outage: limiter fails closed with 503; readiness fails. Repair PostgreSQL,
check schema/readiness, then retry. Transaction locks release on connection death;
uncommitted snapshots roll back. Full snapshot capacity leaves analysis available
with a caveat: export/archive selected old reports using an operator transaction,
verify their backup, then delete only the approved IDs. Do not delete all reports.
Production uses PostgreSQL; development file storage publishes via synced temp
files and hard links. After a crashed development writer, stop every writer,
remove the exact `.write-lock` directory and `.pending-*` files in that configured
store, then restart. Never remove a lock while a writer is active.

Before release, retain the previous immutable image digest and a verified backup.
On regression, pause ingress, deploy the previous digest with the same secrets and
database, verify readiness and one known snapshot, then reopen ingress. Migration
001 is additive. Future destructive migrations require expand/contract releases
and a reviewed restore plan; an old image cannot automatically undo schema changes.

## Load and recovery qualification

Run `LOAD_TEST_URL=https://staging-host node scripts/load-test.cjs` against the
proxy: 100 requests, concurrency10, invalid inputs and rotating forged forwarding
headers. Expect at most5 HTTP400/minute from one socket identity, then429.
Set SNAPSHOT_ID for saved-report reads (60/minute/client). Repeat with2 app
instances, concurrency50, and a realistic mix of trusted client IPs. Record p50,
p95, throughput, errors and DB lock waits. Acceptance target: p95<500ms for cached
snapshot reads at agreed load, zero unexpected5xx or cap overruns. This target
requires measurements on the actual deployment; the local script alone proves none.
In staging stop/restart PostgreSQL and kill one app during saving; verify503 while
down, readiness recovery, complete immutable rows, intact history and global caps.
Rehearse proxy-secret rotation, backup restoration and image rollback. Live GitHub
and optional billed AI checks: `node scripts/verify-integrations.cjs`; evidence is
written to MD/live-integration-evidence.json. Obtain deployment-specific approval
only after container, HTTPS, alert delivery, backup and rollback drills pass.
