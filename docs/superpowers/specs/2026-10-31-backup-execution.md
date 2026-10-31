# Reliable backup execution and guided recovery

## Agreed behavior

- Inspect an execution summary before choosing retry scope. Show every source/destination pair, failed stage, errors, completed artifacts, and linked retry attempts. A retry creates a current backup, not a historical recovery point.
- Notify on first failure, retry within schedule limits, then notify recovered or final failure. Group messages by execution; list affected pairs.
- Detect both missed starts and stale successful backups, separately from long-running work.
- Track freshness per source/destination pair. Destinations are required by default and can be optional per schedule. Only an artifact whose verification passed resets freshness. Track restore-rehearsal evidence separately.
- On restart record missed occurrences and enqueue one current catch-up execution per affected enabled schedule, respecting overlap and concurrency controls.
- Default to one backup at a time per source-server group. Automatically group normalized host/port; administrators can override aliases/proxies and configure a higher group limit.
- Manual, scheduled, retry and catch-up work share FIFO admission. Show wait reasons and queue positions. Administrators may reprioritize waiting work with an audit record; active work is not preempted.
- Cancel queued work immediately. Stopping running work requires confirmation. Preserve completed artifacts and history, record interrupted/not-started pairs, attempt partial cleanup, and retain cleanup warnings.
- Default guided recovery to a dedicated recovery-only connection, verification and review of evidence. Production restore is a separate explicit administrator action. Preserve renamed restore where supported and overwrite with confirmation.

## Engineering decisions proposed for review

- Keep Node >=22.0.0, NestJS/Fastify, sql.js, vanilla JavaScript, the existing portable client tools and canonical public/styles.css. Add no runtime dependencies.
- Enforce one application writer per DATA_DIR for the process lifetime. Multiple independent DATA_DIR instances remain supported. This release does not provide HA or distributed workers.
- Global backup concurrency defaults to 4 (range 1–32); group concurrency defaults to 1 (range 1–8, effective limit never exceeds the global limit). A slot covers one source/destination attempt through cleanup. Retries release slots while waiting.
- Missed-start grace defaults to 15 minutes (range 1–1440). Verified-artifact maximum age defaults to the existing 26 hours (range 1–8760); long-running warning defaults to 120 minutes (range 1–10080). These are schedule settings. Paused schedules do not generate new overdue alerts or catch-up work.
- A source means the saved connection and its selected database scope, not an individual table. Changing scope/configuration starts a new protection fingerprint; old artifacts remain available but do not prove freshness for the changed selection.
- Preserve existing retry count/delay, compression, encryption, layout, insert mode, retention and backup formats. Existing notification preferences remain respected. Optional destinations do not suppress execution failures or delivery alerts.
- Existing historical runs are labelled legacy; do not fabricate aggregate membership. New executions snapshot non-secret configuration, requiredness and source groups. Resolve encrypted credentials at dispatch; missing/deleted references produce an explicit pair failure.
- Execution status: queued, running, retrying, success, partial_failure, failed, cancel_requested, cancelled, interrupted. Pair status additionally distinguishes not_started; attempts are immutable terminal records. Aggregate success requires every pair to succeed; required-destination protection is a separate assessment.
- FIFO applies among eligible waiting pairs per source group. A delayed retry cannot block ready work. Reprioritization is explicit and audited. No group slot is held while waiting for another slot.
- Interrupted attempts are never relabelled successful after restart. Before retrying, record any uncertain remote-upload state and cleanup evidence. Never delete an unproven remote artifact.
- Persist notification intent with state transitions. Delivery is at least once; a crash after provider acceptance may cause a duplicate. Use stable event IDs, bounded retries and visible delivery errors; never claim exactly once delivery.
- Migration is additive and repeatable, with backups of SQLite before the first upgrade. Never reset DATA_DIR, alter encryption keys, overwrite production data for validation, commit credentials, or publish a release as part of implementation.

## Acceptance

One execution containing three sources and two targets visibly accounts for all six pairs. A failed pair is inspectable and selectively retryable without rerunning the other five. Queued cancellation, running cancellation, restart, alias grouping, required/optional destinations, verified-only freshness and notification recovery have deterministic tests. Existing download, history, schedule editing, PITR and recovery artifact formats remain compatible.

## Protection evidence policy

A schedule with no artifact history receives its maximum verified-age window from its persisted creation time. The service reports `grace` with an explicit deadline; after that deadline it reports stale. Current-configuration execution snapshots establish which selection was attempted, but do not reset this deadline. A failed or unverified upload never advances the verified-artifact clock. Complete matching recorded run configuration and successful verification are required for freshness; incomplete legacy metadata or only a previous selection is `unknown`, never fresh. Future-dated artifact, queue, creation or running-attempt evidence is unknown until the clock catches up.

Paused schedules retain existing incident evidence without opening or resolving incidents on that condition. Resume uses the existing clocks; it does not grant a fresh grace window. Long-running warnings use the active attempt's start, excluding retry waiting time. Missed-start status concerns the most recent scheduled/catch-up occurrence and the next persisted overdue occurrence, independently of manual executions. A later scheduled start clears that current condition while historical incidents/events remain stored. Optional destinations remain visible in assessments and execution failures, but do not open required-protection incidents. Removing a pair, changing its fingerprint or marking it optional closes an incident as a policy/configuration change rather than reporting recovered evidence. Restore rehearsal has its own evidence clock and is not used here.
