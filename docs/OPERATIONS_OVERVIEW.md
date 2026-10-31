# Operations overview

Overview prioritizes running processes, destination capacity for the next scheduled backup, and upcoming jobs. Live process updates use the existing authenticated SSE stream. A disconnected stream or process snapshot older than 30 seconds is shown as unavailable rather than idle.

Capacity estimates use Overview's independent, unfiltered window of the latest 100 backup runs. For each destination's next enabled schedule, every selected source must have a successful artifact within 30 days matching the recorded database selection, scope, layout, object options, compression, and encryption. The largest matching artifact per source is summed and 25% headroom is added.

The comparison requires a successful destination health check no older than five minutes that reports free bytes. Provider capacity that is unavailable, stale checks, and missing matching history produce **Unknown**. Use Storage targets to run a health check. Historical artifact sizes are estimates, not a guarantee of future backup size.

The estimate excludes retention savings, competing jobs, shared volumes, temporary workspace, and growth after the observation. Each destination is assessed separately; free space is not reserved. Changing a schedule's insert mode may also change artifact size. No days-until-full forecast is provided: current metadata does not establish a reliable net-growth rate after retention and other storage writes.

History page filters do not affect these estimates or Overview's run totals. Storage health samples persist nullable free bytes with their check time; unsupported providers remain Unknown.

## Durable executions and queue

Run now returns a queued execution immediately. History groups every source/destination pair and its attempts under that execution. Inspect the summary before selecting failed or not-started pairs to retry. Successful original artifacts remain in history; a retry creates a linked execution using the original recorded configuration. Retry all requires a separate confirmation because successful pairs run again.

All manual, scheduled, catch-up, and retry work shares an eligible FIFO queue. The default global concurrency is four; each source group defaults to one, configurable from one to eight (global one to 32). Automatic groups normalize the source host and port without DNS resolution. Administrators can group hostname aliases explicitly. Group membership and source host/port/engine cannot change while affected work is queued or running. Credentials can be repaired before dispatch. Delayed retries release their slots. Move ahead changes priority without preempting running work and records the administrator in audit evidence.

Queued cancellation prevents remaining pairs from starting. Running cancellation requires confirmation and waits for subprocesses, streams and transfers to settle. Already uploaded artifacts remain evidence, and cleanup or retention warnings stay visible. Shutdown interrupts active work; it does not silently report success. A restart records interrupted attempts and admits at most one catch-up execution per enabled overdue schedule, with the missed range/count.

## Protection and notification evidence

Required destinations default to true. Protection is assessed for each source/destination and recorded backup configuration. Upload success alone does not reset freshness: verification must pass. Defaults are 15 minutes of missed-start grace, 26 hours maximum verified-artifact age, and 120 minutes for a long-running warning. Optional destination failures remain visible without opening required-destination incidents. Rehearsal confidence is separate from artifact freshness. A policy change or destination removal closes an obsolete incident without claiming recovery.

Notifications group failures by execution. First failure, final failure, recovery, missed starts, stale artifacts and long-running work have separate preferences. Notification delivery uses a durable outbox, a ten-second provider timeout, and up to five attempts with delays of one, five, 15 and 60 minutes. Settings shows pending, delivered, superseded and exhausted evidence. Delivery is at least once: a crash after provider acceptance but before receipt persistence can duplicate a message. A successful selected-pair retry reports only that scope as recovered.

## Application data ownership and upgrades

Only one application process may write a DATA_DIR. The SQLite implementation exports whole-file snapshots; multiple workers sharing the same directory are unsupported. Ownership is acquired before loading data, and shutdown waits for workers and notification delivery before releasing it. Do not remove an ownership file while its process is alive. An ambiguous or abandoned acquisition gate fails closed: stop every process using that directory, preserve a copy, inspect the recorded PID/token and gate, and remove stale ownership files only after proving no writer remains. Do not run offline reset/import utilities against an active directory.

The schema upgrades are additive and preserve existing schedules, artifacts and credentials. The first execution-schema upgrade saves a pre-upgrade database copy. Preserve DATA_DIR and its encryption key before upgrading. For rollback, stop the application and restore a compatible complete saved state and matching key; do not replace a live database or assume an older version understands new execution records. Existing synchronous run/retry endpoints retain their completed-result behavior; the UI uses the new asynchronous execution endpoints. Restart the application after installing this change.
