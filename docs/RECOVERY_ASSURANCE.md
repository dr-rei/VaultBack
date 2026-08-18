# Recovery Assurance

Recovery Assurance turns “the backup job succeeded” into evidence that a database can actually be recovered.

## Restore rehearsals

1. Open **Recovery assurance** and choose **Add restore test**.
2. Select a backup schedule and a separate database connection. The destination should be an isolated server or a disposable database account.
3. Choose a weekly or monthly cron schedule.
4. Use **Run test** for the first rehearsal.

VaultBack selects the latest successful artifact, confirms the file still exists, restores it under a generated temporary database name, verifies the destination, records RPO/RTO and evidence, and removes the temporary database. It never uses the overwrite restore mode for a recovery test. A failed cleanup is reported as a warning so an administrator can remove the temporary database manually.

The first implementation supports single-database “restore as new name” verification. Multi-database archives remain available for ordinary restore, but are not silently treated as a complete isolated rehearsal.

## Policy findings

The policy center flags missing successful backups, stale recovery points, schedules without a restore rehearsal, and storage targets without provider-enforced immutability evidence. Local disk, FTP, WebDAV, Google Drive, and OneDrive are not described as immutable merely because they are remote or encrypted. VaultBack supports S3-compatible Object Lock: create the bucket with Object Lock enabled, configure an S3 target with **Require provider-enforced Object Lock**, then run its health check. VaultBack uploads with COMPLIANCE retention and skips deletion during rotation. A successful configuration test is required before the policy treats it as verified.

## Point-in-time recovery

The PITR panel checks whether binary logging is enabled, the binlog format, GTID information, and the visible binary-log range. Administrators can choose **Capture current binlogs** and upload the raw files to a storage target; each artifact receives a checksum and capture record. This is a real off-host capture step, but it is intentionally not presented as a complete PITR service: VaultBack does not yet apply captured binlogs to a destination automatically, and the administrator must monitor capture frequency, retention, and continuity before relying on the files.

## Fleet foundation

The administrator-only fleet section stores an installation identity and a hash of a one-time enrollment token. The token is never returned or stored in plaintext. Revocation is recorded in the local control plane. This is an enrollment and accountability foundation, not remote command execution or credential sharing.

## Operational targets

Record a recovery point objective (how much data may be lost) and recovery time objective (how long restoration may take) for each important schedule. Rehearse the highest-value schedule first, keep at least one isolated destination, and preserve the evidence with the application database.
