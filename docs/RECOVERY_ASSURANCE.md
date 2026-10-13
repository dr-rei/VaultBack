# Recovery Assurance

Recovery Assurance turns “the backup job succeeded” into evidence that a database can actually be recovered.

## Restore rehearsals

1. Open **Recovery assurance** and choose **Add restore test**.
2. Select a backup schedule and a separate database connection. The destination should be an isolated server or a disposable database account.
3. Choose a weekly or monthly cron schedule.
4. Use **Run test** for the first rehearsal.

VaultBack selects the latest successful artifact, confirms the file still exists, restores it under a generated temporary database name, verifies the destination, records RPO/RTO and evidence, and removes the temporary database. It never uses the overwrite restore mode for a recovery test. A failed cleanup is reported as a warning so an administrator can remove the temporary database manually.

Each new backup run records its source, storage, configuration, database list, and expected table/view names. Restore verification checks those objects after import. Historical runs that lack a checksum or complete recorded expectations fail closed; create a new backup before using those runs for a verified rehearsal.

The first implementation supports single-database “restore as new name” verification. Multi-database archives remain available for ordinary restore, but are not silently treated as a complete isolated rehearsal.

## Policy findings

The policy center flags missing successful backups, stale recovery points, schedules without a restore rehearsal, and storage targets without provider-enforced immutability evidence. Local disk, FTP, WebDAV, Google Drive, and OneDrive are not described as immutable merely because they are remote or encrypted. VaultBack supports S3-compatible Object Lock: create the bucket with Object Lock enabled, configure an S3 target with **Require provider-enforced Object Lock**, then run its health check. VaultBack uploads with COMPLIANCE retention and skips deletion during rotation. A successful configuration test is required before the policy treats it as verified.

## Scheduled point-in-time recovery

PITR is disabled until an administrator configures it. Choose a MySQL or MariaDB source, an enabled single-file schedule that covers all user databases and includes views, routines, triggers, and events, a storage target for binlogs, and a capture interval from 1 to 1,440 minutes. “All databases” here means all visible user databases; VaultBack excludes the `mysql`, `sys`, `performance_schema`, and `information_schema` system schemas so PITR does not restore server accounts or internal metadata.

After the next successful baseline run, VaultBack records the engine-specific binlog coordinate in the dump (`--source-data=2` for MySQL, `--master-data=2` for MariaDB). MySQL's option requires a suitable privilege for `SHOW BINARY LOG STATUS` and `RELOAD`; the dump account also needs the object-reading privileges for the selected databases. Confirm the exact privilege requirements for the installed MySQL or MariaDB version and grant only what the dump and remote binlog client need. MySQL's `mysqlbinlog --read-from-remote-server` requires `REPLICATION SLAVE` on the source. The managed MariaDB binlog client may not recognize newer MySQL server versions; set `MYSQL_BINLOG_PATH` to a compatible MySQL `mysqlbinlog` executable when needed. This setting affects only PITR binlog capture and replay; normal database connections continue to use the managed tools. See the [MySQL mysqldump documentation](https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html), [MySQL mysqlbinlog backup documentation](https://dev.mysql.com/doc/refman/8.4/en/mysqlbinlog-backup.html), and [MariaDB mariadb-dump documentation](https://mariadb.com/docs/server/clients-and-utilities/backup-restore-and-import-clients/mariadb-dump).

VaultBack captures the source's visible binlog sequence on the configured interval, uploads each raw file with a SHA-256 checksum, and versions repeated captures of the active log. A changed log prefix, an unparseable sequence, a missing number, a purged baseline log, or a failed capture marks coverage as a gap. `log_bin=ON` alone is only a capability signal. Keep the interval comfortably shorter than the source's binlog expiration period. PITR artifacts are not automatically pruned, so storage grows until an administrator removes old evidence after checking which baseline runs still depend on it.

To rehearse a recovery point, configure a dedicated recovery-only MySQL or MariaDB connection of the same engine, select the current baseline run, and choose a UTC time within the captured range. VaultBack converts that UTC time to the client machine's local timezone for `--stop-datetime`, which both vendor tools interpret locally. The recovery account needs permission to create and drop scratch databases, create the backed-up objects, and apply binlog events. MySQL binlog replay may require `BINLOG_ADMIN` or `REPLICATION_APPLIER` plus the event-specific database privileges; MariaDB privilege names vary by version (including `BINLOG REPLAY` or administrative privilege requirements). Do not use a general production account for the recovery destination.

Rehearsal downloads and hash-checks the baseline and every required binlog, checks sequence continuity, decodes events only up to the requested time, and replays them into randomly named scratch databases. It checks that the names do not already exist, creates each database exclusively, verifies the restored objects, and attempts cleanup in `finally`. Cleanup failures remain in the rehearsal evidence. Server accounts, grants, global configuration, dynamic SQL (`PREPARE`/`EXECUTE`), stored procedure calls, external-file statements, and other server-level actions are outside the PITR claim and are rejected. Database references embedded in strings are not rewritten; if an unrecognized reference remains in executable SQL, validation stops before replay. VaultBack uses dump completion as the conservative earliest accepted recovery timestamp, so a target inside a long-running baseline dump is refused even if its actual binlog coordinate was recorded earlier.

A continuous capture status is evidence that the baseline coordinate and visible log sequence have been captured; it does not prove every event can be applied successfully. A successful point-in-time rehearsal is the evidence that that specific base, target time, and recovery connection worked. See [MySQL point-in-time recovery](https://dev.mysql.com/doc/refman/8.4/en/point-in-time-recovery.html), [MariaDB point-in-time recovery with logical dumps](https://mariadb.com/kb/en/point-in-time-recovery-pitr/), [MySQL binlog rewriting limits](https://dev.mysql.com/doc/refman/8.4/en/mysqlbinlog.html), and [MariaDB binlog rewriting limits](https://mariadb.com/docs/server/clients-and-utilities/logging-tools/mariadb-binlog/mariadb-binlog-options).

## Fleet foundation

The administrator-only fleet section stores an installation identity and a hash of a one-time enrollment token. The token is never returned or stored in plaintext. Revocation is recorded in the local control plane. This is an enrollment and accountability foundation, not remote command execution or credential sharing.

## Operational targets

Record a recovery point objective (how much data may be lost) and recovery time objective (how long restoration may take) for each important schedule. Rehearse the highest-value schedule first, keep at least one isolated destination, and preserve the evidence with the application database.
