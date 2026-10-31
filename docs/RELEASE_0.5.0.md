# VaultBack v0.5.0

## New features

- Durable backup executions group every source/destination pair, its attempts, artifacts, errors and cleanup evidence. Inspect executions and selectively retry failed or not-started pairs without repeating successful deliveries.
- A shared FIFO queue handles manual, scheduled, catch-up and retry work. Configure source-server aliases and concurrency, move queued work ahead, and cancel queued or running work with explicit confirmation.
- Per-destination protection policies distinguish required and optional targets, verified-artifact freshness, missed starts and long-running work.
- A durable notification outbox groups execution incidents and records delivery attempts, recovery, suppression and exhausted failures.
- Guided recovery rehearses an artifact on a dedicated recovery server using generated scratch databases, records verification and cleanup evidence, and keeps production restore as a separate confirmed action.
- The operations-first interface prioritizes running work, upcoming schedules and evidence-based destination capacity, with light/dark and responsive workflows.

## Correctness and safety

- Preserve uploaded artifact evidence when retention or cancellation encounters a later problem; acknowledge partial retention deletions individually.
- Verify checksums, archive manifests and expected database objects before claiming recovery success. Reject scratch collisions and unsafe SQL before creating destination databases.
- Preserve UTF-8 across SQL stream boundaries and full comment/string context during validation; disable native client shell/source/connect commands for file imports.
- Revalidate active SSE sessions, restrict administrator operations, preserve asynchronous UI request ownership and keep Overview independent of History filters.
- Enforce one writer per application data directory and persist application state using atomic file replacement and synchronous transactions.

## Upgrade notes

- Stop active work and back up `DATA_DIR`, `.env` and the matching encryption key before upgrading. Preserve `APP_ENCRYPTION_KEY` and all existing backup artifacts.
- Run exactly one application process per `DATA_DIR`. PM2 cluster workers sharing a directory are unsupported. An ambiguous ownership lock fails closed; inspect it only after every writer has stopped.
- Schema upgrades are additive. A pre-execution-schema database copy is retained on first upgrade, but rollback requires a compatible complete saved state and matching key. Never replace a live database.
- Restart the application after installation. aaPanel users should use the install-only installer and restart from the aaPanel GUI.
- Global backup concurrency defaults to four, with one active pair per source group. Required destinations default to true; missed-start grace is 15 minutes, verified-artifact age 26 hours, and long-running warning 120 minutes.
- Notification delivery is at least once; provider acceptance followed by a crash before receipt persistence can duplicate a notification.
- Dedicated recovery accounts need scratch database creation, object restore and cleanup privileges on a separate server. The SQL validator intentionally refuses unsupported statements; rehearsal verifies expected objects, not application behavior or all row values.

## Validation

- 177 automated tests across 24 suites passed, along with type checking, build, frontend syntax and whitespace checks.
- Disposable Windows MariaDB tests covered a six-pair partial execution, selective retry, real dump cancellation, three-database backup and rehearsal for single gzip/database ZIP/table ZIP layouts, cleanup, legacy API compatibility, authorization and SSE session revocation.
- Browser checks covered both themes at 390, 768 and 1440 pixels, including recovery dialog overflow and keyboard behavior.
- Genuine MySQL-server, Linux process, external storage provider and notification-provider live checks were not run. No existing application data was used for live validation.

Full changelog: https://github.com/dr-rei/VaultBack/compare/v0.4.2...v0.5.0
