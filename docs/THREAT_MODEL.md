# VaultBack threat model

## Overview

VaultBack is a self-hosted NestJS/Fastify service with a vanilla JavaScript browser client, an automatically managed SQLite control-plane database, encrypted database/storage credentials, portable dump tools, configured storage providers, and an authenticated SSE stream. The primary security objective is to prevent unauthorized backup disclosure, destructive restore, credential theft, and false recovery confidence.

## Threat model, trust boundaries, and assumptions

- The browser is untrusted. Every state-changing API route must enforce a session, CSRF protection, role authorization, DTO validation, and server-side ownership checks.
- The VaultBack process, `DATA_DIR`, encryption key, bundled tools, and configured database/storage endpoints are trusted only to the degree that the host account and service supervisor are protected.
- Database and storage servers are external trust boundaries. Their credentials may read sensitive data and, for restore destinations, may modify or delete data.
- Backup archives and remote storage are hostile to integrity until checksum, archive, and restore verification succeeds.
- The application assumes the operator preserves `APP_ENCRYPTION_KEY` or `data/.encryption-key` across redeployments and protects the host filesystem.

## Attack surface and mitigations

- **Credentials:** AES-256-GCM at rest, redacted API responses, no secret values in audit logs or SSE payloads.
- **Restore:** explicit overwrite confirmation, strict database-name validation, generated names for recovery tests, post-restore verification, and cleanup in `finally`.
- **Archives:** path validation, safe ZIP entry validation, checksums, encryption authentication, and temporary-file cleanup.
- **Realtime:** authenticated SSE, role-filtered topics, bounded connection counts, and safe snapshots.
- **Storage deletion:** provider adapters must treat missing files as idempotent and never claim immutability without provider evidence.
- **PITR:** report capability and binlog gaps; never label binary logging alone as a tested recovery chain.
- **Fleet enrollment:** one-time token hash, administrator-only enrollment/revocation, no remote execution, and installation isolation.

## Attacker stories

1. A viewer tries to invoke a restore endpoint directly: the controller rejects the request before any storage download.
2. An attacker steals the SQLite file but not the encryption key: credential ciphertext cannot be decrypted.
3. A backup file is deleted after a successful run: reconciliation marks the record expired and it is not presented as downloadable.
4. A recovery test crashes after creating its temporary database: the `finally` cleanup attempts a drop and the evidence records cleanup warnings.
5. A user requests an admin-only SSE topic: the server filters it from the connection rather than trusting the requested topic list.

## Severity calibration

Critical: unauthorized credential disclosure, arbitrary destructive restore, or cross-installation data access. High: bypassing role/CSRF controls, unverified recovery presented as ready, or a persistent archive integrity failure. Medium: stale policy detection, missing evidence, or provider capability ambiguity. Low: incomplete operational guidance that does not change authorization or data integrity.
