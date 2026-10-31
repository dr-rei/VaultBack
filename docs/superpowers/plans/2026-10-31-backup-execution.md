# Reliable Backup Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the agreed durable backup execution, protection monitoring, notifications and guided recovery workflow.

**Architecture:** A deep execution module owns persisted queue admission, execution/pair/attempt state, retry and cancellation transitions. The existing dump/storage implementation becomes its execution adapter; a protection module derives freshness and missed-start evidence, and a notification outbox delivers grouped events. Keep a single writer per DATA_DIR because sql.js stores an in-memory database and exports the entire file.

**Tech Stack:** Node >=22.0.0, TypeScript, NestJS/Fastify, sql.js, Jest, vanilla JavaScript, existing portable MySQL/MariaDB tools.

**Spec:** `docs/superpowers/specs/2026-10-31-backup-execution.md`

## Global Constraints

- Keep Node >=22.0.0; add no runtime dependencies. Use public/styles.css as the canonical stylesheet.
- One application writer per DATA_DIR. Preserve runtime data, encryption keys, formats and existing endpoints.
- Global concurrency 4 (1–32); source group concurrency 1 (1–8, capped by global).
- Missed-start grace 15 minutes (1–1440); maximum verified age 26 hours (1–8760); long-running warning 120 minutes (1–10080).
- Required destinations default true. Freshness requires successful artifact verification; restore confidence is separate.
- Existing retry count/delay and notification preferences remain effective. A retry creates a new current artifact.
- All mutation endpoints require administrator authorization and CSRF. SSE exposes no credentials or administrator-only evidence to lower roles.
- Tests use dummy principals and disposable data. No production restore, data reset, release, commit or push without separate authorization. Commit steps below are future checkpoints, not authorization.

## Review Focus

- Two app processes sharing DATA_DIR must fail safely before stale sql.js snapshots can overwrite each other: Task 1 contention tests.
- Restart between upload and state persistence must retain uncertainty and completed evidence rather than repeat or delete silently: Tasks 2–4 crash-injection tests.
- Changed selections, deleted references and aliases must not inherit unrelated freshness or bypass source limits: Tasks 2, 3 and 5 tests.
- Cancellation during upload/rotation/retry must preserve valid artifacts and visible cleanup failures: Task 4 race tests.
- Clock/timezone changes and disconnected SSE must not fabricate missed starts, readiness or successful notification delivery: Tasks 3, 5–7 tests.

## File and module map

- Modify `src/database/database.service.ts`: additive schema, transaction primitive, atomic persistence and writer ownership integration.
- Create `src/database/data-owner.ts`: process-lifetime exclusive DATA_DIR ownership and crash-safe recovery.
- Create `src/backup/execution.types.ts`, `execution.store.ts`, `execution.service.ts`: domain records, persistence, state machine and FIFO dispatch.
- Modify `src/backup/backup.service.ts`: retain dump/verification/retention code behind a pair execution adapter, remove duplicated scheduling/retry ownership.
- Modify `src/backup/backup.scheduler.ts`, `backup.controller.ts`, `backup.module.ts`: scheduler triggers, authenticated interface and composition.
- Create `src/backup/protection.service.ts`: pair-level freshness and missed/long-running assessments.
- Create `src/system/notification-outbox.service.ts`; modify `system.service.ts` and module: grouped durable notifications using existing providers.
- Modify `src/common/request-dtos.ts`: validated queue/group/policy/cancellation/retry input.
- Modify `src/recovery/recovery.service.ts`, `recovery.controller.ts`: single-artifact guided rehearsal using existing scratch-restore behavior.
- Modify `src/system/realtime.service.ts`, `realtime.controller.ts`: authenticated role-filtered execution/protection snapshots, session revalidation.
- Modify `public/index.html`, `public/app.js`, `public/styles.css`, `public/operations.js`: queue, execution detail, destination policies, grouped retry/cancel/recovery actions.
- Add focused Jest files named in each task. Modify `docs/OPERATIONS_OVERVIEW.md`, `docs/RECOVERY_ASSURANCE.md`, `docs/README.md` after implemented behavior is verified.

## Shared types and route decisions

`ExecutionTrigger = 'scheduled' | 'manual' | 'retry' | 'catchup'`. `PairSelection = {connectionId: string; storageTargetId: string}`. `ExecutionView` contains id, jobId, trigger, status, scheduledFor, queuedAt, startedAt, finishedAt, parentExecutionId, pairs and cleanupWarnings. Pair views contain stable id, selection fingerprint, sourceGroupId, required, status, waitReason, queuePosition and attempts; attempts link `backup_runs.id`. `RequestActor = {userId: string}`. Never put decrypted credentials in these records.

Add GET `/api/executions`, GET `/api/executions/:id`, POST `/api/jobs/:id/executions`, POST `/api/executions/:id/retries`, POST `/api/executions/:id/cancel`, POST `/api/executions/:id/priority`, GET `/api/protection`, GET/POST `/api/source-groups`, POST `/api/recovery/rehearsals`. Mutation bodies are DTO validated. Execution/protection reads require session; mutation and recovery evidence require admin as appropriate. Existing run/retry endpoints remain adapters preserving their documented response shape; add optional executionId and update frontend to use the new asynchronous endpoints.

### Task 1: Safe ownership, transactions and additive schema

**Files:** Create `src/database/data-owner.ts`; modify `src/database/database.service.ts`; test `test/execution-migrations.spec.ts`, `test/data-owner.spec.ts`.

**Interfaces:** Produce `DataOwner.acquire(dataDir: string): () => void` and `SqliteFile.transaction<T>(work: () => T): T`. The transaction persists once; failure restores prior in-memory state and leaves the original on-disk database valid.

- [x] Write failing tests: second process cannot open the same DATA_DIR; independent directories work; dead-owner recovery cannot steal a live lock; repeated migration preserves credentials/runs; injected write failure retains readable original bytes.
- [ ] Initial red-run evidence was not retained. Focused post-implementation validation passed; do not claim the pre-implementation failure was observed.
- [x] Acquire exclusive ownership before reading SQLite and release only after final persistence. Use exclusive creation, owner token and PID; fail closed on ambiguous ownership. Atomic same-directory temporary export/rename; preserve permissions and clean temporary files. Prove Windows rename and crash cases in integration tests.
- [x] Add `source_groups`, connection group references, `backup_executions`, `backup_execution_pairs`, `backup_execution_attempts`, `execution_events`, `notification_outbox`, `protection_incidents`. Add required flag default 1 on job-storage links and schedule thresholds from Global Constraints. Unique keys enforce schedule occurrence identity, pair membership and attempt numbering. Add nullable attempt/execution links to backup_runs. Keep legacy runs intact. Backup SQLite once before upgrading; no keys in migration output.
- [x] Rerun focused tests; expect PASS including two-process contention with generated scratch DATA_DIR.
- [ ] Future commit checkpoint (not authorized; no commit created): `feat: persist backup execution state safely`.

### Task 2: Execution snapshots, pair results and selective retry

**Files:** Create `src/backup/execution.types.ts`, `execution.store.ts`, `execution.service.ts`; modify `backup.service.ts`, `backup.module.ts`; test `test/execution-results.spec.ts`.

**Interfaces:** Produce `enqueue(jobId: string, trigger: ExecutionTrigger, actor: RequestActor | null, scheduledFor?: string): ExecutionView`, `get(id: string): ExecutionView`, `retry(id: string, pairs: PairSelection[], actor: RequestActor): ExecutionView`. Consume Task 1 transactions. Adapter produces `executePair(context: PairExecutionContext, signal: AbortSignal): Promise<PairOutcome>` where context carries attemptId, configuration snapshot and reference IDs; outcome carries runId, status, failedStage, error and cleanupWarnings.

- [ ] Write failing tests: 3 sources × 2 destinations yields six unique pair records; five successes plus one failure produces partial_failure; retry one pair leaves five original artifacts untouched and links its new execution; unauthorized/unrelated pair selectors reject; deleted references fail explicitly; edited jobs do not mutate existing snapshots.
- [ ] Run `node node_modules/jest/bin/jest.js --runInBand test/execution-results.spec.ts`; expect FAIL.
- [ ] Implement immutable non-secret configuration snapshots and normalized selection fingerprint (scope, ordered-independent names, layout, objects, insert mode, compression, encryption). Refactor only pair execution from the existing run path. Retain historical metadata, verification and artifact formats. Aggregate success requires all pairs; preserve attempt-level errors.
- [ ] Rerun focused tests and `test/pitr-workflows.spec.ts`; expect PASS. Verify downloads/restores still resolve run-level source/storage metadata.
- [ ] Review diff. Future checkpoint: `feat: track executions and selective backup retries`.

### Task 3: Shared FIFO admission, source groups and restart catch-up

**Files:** Modify `execution.service.ts`, `execution.store.ts`, `backup.scheduler.ts`, `backup.service.ts`, `request-dtos.ts`; test `test/execution-queue.spec.ts`.

**Interfaces:** Produce `dispatch(now: Date): Promise<void>`, `recover(now: Date): void`, `reprioritize(id: string, actor: RequestActor): ExecutionView`, `saveSourceGroup(input: {id?: string; name: string; connectionIds: string[]; concurrency: number}, actor: RequestActor): SourceGroupView`. SourceGroupView contains id/name/concurrency/connectionIds; connection DTO accepts optional sourceGroupId. Consume Task 2 adapter.

- [ ] Write failing tests for same-host different-connection serialization, case/trailing-dot host normalization, IPv6 spellings, explicit alias override, different-server parallelism, global/group caps, retry-delay eligibility, audited non-preemptive priority, and duplicate scheduler ticks.
- [ ] Add fake-clock tests for outage across three occurrences yielding one catch-up, persisted occurrence uniqueness, paused schedule exclusion, DST transition, clock rollback, and interrupted attempt recovery without success fabrication.
- [ ] Run `node node_modules/jest/bin/jest.js --runInBand test/execution-queue.spec.ts`; expect FAIL.
- [ ] Implement host/port grouping without DNS queries, administrator group overrides, validated limits, and atomic slot acquisition under Task 1 single ownership. All entry paths enqueue through the same module; remove in-memory queued-set and nested retry timers as owners. Order eligible work by explicit priority then monotonic enqueue sequence. Release slots before retry delay. Persist scheduled occurrence and next due update in one transaction; record missed range/count and enqueue one catch-up, computing cron in the job timezone.
- [ ] Rerun queue/results tests with deterministic concurrency barriers, expect PASS; prove no slot leak on thrown adapter errors.
- [ ] Review diff. Future checkpoint: `feat: queue backup work by source server`.

### Task 4: Cancellation and artifact-safe cleanup

**Files:** Modify `execution.service.ts`, `backup.service.ts`, `src/storage/storage.service.ts`; test `test/execution-cancellation.spec.ts`.

**Interfaces:** Produce `cancel(id: string, actor: RequestActor, stopRunningConfirmed: boolean): ExecutionView`. Thread Task 2 AbortSignal through subprocesses, compression, verification, transfer and rotation adapter operations. PairOutcome distinguishes cancelled/interrupted/failed; completed artifacts remain successful evidence.

- [ ] Write failing tests: queued cancel launches no process; running stop without confirmation rejects; child exit race, cancellation during upload/retention, retry timer cancellation, repeated cancel, cleanup error and crash after remote upload retain truthful states.
- [ ] Run `node node_modules/jest/bin/jest.js --runInBand test/execution-cancellation.spec.ts`; expect FAIL.
- [ ] Implement cooperative abort with Windows/Linux child termination handling and bounded escalation. Finish bounded in-flight destructive storage operations before reporting cancellation; do not pretend abort can undo them. Skip future rotation after cancellation. Clean only artifacts positively owned by the attempt; preserve completed uploads and uncertain remote outcomes. Always retain cleanup warnings and release queue slots in finally.
- [ ] Rerun queue/cancellation tests; expect PASS. Verify supported portable tools terminate in disposable platform tests or report the exact unavailable platform check.
- [ ] Review diff. Future checkpoint: `feat: cancel queued and running backups safely`.

### Task 5: Required destinations and verified freshness

**Files:** Create `src/backup/protection.service.ts`; modify schedule DTO/save logic, scheduler and recovery policy integration; test `test/protection-policy.spec.ts`.

**Interfaces:** Produce `assess(now: Date): ProtectionAssessment[]` and `evaluateIncidents(now: Date): void`. Assessment includes jobId, connectionId, storageTargetId, required, fingerprint, latestVerifiedRunId, latestVerifiedAt, freshnessStatus, missedStartStatus, longRunningStatus and evidence. Consume executions/attempts; never query only job-level latest success.

- [ ] Write failing tests: successful upload with failed verification does not reset freshness; one required pair stale while another fresh warns; optional failure remains visible; new scope cannot inherit old freshness; no-history/new schedule grace, pause/resume, long-running retry and clock rollback behave deterministically.
- [ ] Run `node node_modules/jest/bin/jest.js --runInBand test/protection-policy.spec.ts`; expect FAIL.
- [ ] Implement per-pair verified-artifact clock and separate missed-start/long-running incidents using configured thresholds. Assess legacy verified runs only when recorded configuration proves the same fingerprint; otherwise show unknown evidence. Persist incident transitions so scheduler ticks do not create duplicate events. Preserve recovery rehearsal evidence as a separate clock.
- [ ] Rerun policy and existing recovery tests; expect PASS.
- [ ] Review diff. Future checkpoint: `feat: monitor verified protection per destination`.

### Task 6: Grouped durable notifications

**Files:** Create `src/system/notification-outbox.service.ts`; modify `system.service.ts`, `system.module.ts`, execution/protection integration; test `test/execution-notifications.spec.ts`.

**Interfaces:** Produce `record(event: ExecutionNotification): void`, `deliverDue(now: Date): Promise<void>`. ExecutionNotification contains stable eventId, executionId/incidentId, kind (first_failure/recovered/final_failure/missed_start/stale/long_running), affected pairs and safe message. The existing provider adapter becomes `sendNotification(event: string, message: string): Promise<void>` and must reject non-2xx responses.

- [ ] Write failing tests: first failure enqueues immediately, multiple failed pairs update one grouped incident, successful retry sends recovered, exhausted required/optional failures send truthful final summary, provider non-2xx/timeout persists failure, restart preserves deduplication and preferences, cancel does not emit false recovery.
- [ ] Run `node node_modules/jest/bin/jest.js --runInBand test/execution-notifications.spec.ts`; expect FAIL.
- [ ] Persist event intent in the same transaction as execution/incident transition. Deliver outside transactions with 10-second timeout and five attempts at delays 1/5/15/60 minutes. Mark exhausted delivery visibly, never successful by swallowed error. Map existing backup_failed/backup_retry/backup_success/backup_stale preferences and add explicit settings for new incident categories. Stable event ID documents at-least-once semantics.
- [ ] Rerun focused tests; expect PASS and no secrets in logs/audit/event payload fixtures.
- [ ] Review diff. Future checkpoint: `feat: group backup incident notifications`.

### Task 7: Authenticated execution interface and operations UI

**Files:** Modify backup controller/module, request DTOs, realtime module/controller, auth revocation integration, `public/index.html`, `public/app.js`, `public/styles.css`, `public/operations.js`; test `test/execution-controller.spec.ts`, `test/realtime.service.spec.ts`.

**Interfaces:** Expose Shared types and route decisions above, plus SSE `executions` and `protection` snapshots. All reads are credential-free; priority/cancellation actor IDs come from session, never request body. Execution list supports page/pageSize/status/jobId. UI history remains independent from Overview state.

- [ ] Write failing controller tests for admin/CSRF mutations, lower-role reads, invalid pair selection, cancelled retry, priority audit actor binding, current session expiry/revocation on open SSE and admin topic filtering.
- [ ] Run `node node_modules/jest/bin/jest.js --runInBand test/execution-controller.spec.ts test/realtime.service.spec.ts`; expect FAIL.
- [ ] Implement routes and safe compatibility adapters. Revalidate SSE sessions before sends/snapshots and close invalid streams; filter topics by current role. Present execution summary with all pair/attempt outcomes, errors and cleanup evidence. Default retry selection to failed pairs only after inspection; require explicit retry-all. Display queue positions, wait reasons, source group configuration, required flags, thresholds, notifications and cancellation states. Confirm running cancellation; do not hide successful artifacts.
- [ ] Verify with local/disposable data: six-pair partial execution, selective retry, queued reorder/cancel, stale required destination, optional destination, disconnect/reconnect, keyboard dialogs, 390/768/1440px and both themes. Assert no horizontal overflow and no console/network errors. Retain actual screenshots and separate any fixture-only observations from authenticated checks.
- [ ] Rerun focused tests, `node --check public/app.js`, `node --check public/operations.js`, expect PASS.
- [ ] Review diff. Future checkpoint: `feat: expose backup execution and protection workflows`.

### Task 8: Guided recovery and final integration

**Files:** Modify `src/recovery/recovery.service.ts`, `recovery.controller.ts`, DTOs and frontend restore flow; test `test/guided-recovery.spec.ts`; update the three docs listed in File map.

**Interfaces:** Produce `rehearseArtifact(input: {backupRunId: string; recoveryConnectionId: string}, actor: RequestActor): {runId: string}`. Consume existing scratch restore/verification/cleanup implementation. Record tested run ID/hash, destination, timestamps, object counts and warnings. Rehearsal does not invoke production restore.

- [ ] Write failing tests: default action requires recovery-purpose connection; reject matching source/destination group; unavailable/hash-mismatched artifact fails before import; scratch collision never overwrites; cleanup warning remains visible; production action requires a fresh explicit confirmation and does not reuse a rehearsal checkbox.
- [ ] Run `node node_modules/jest/bin/jest.js --runInBand test/guided-recovery.spec.ts`; expect FAIL.
- [ ] Implement single-artifact asynchronous rehearsal by reusing existing recovery internals, without fabricating a durable recurring plan. Default UI action to inspect verified evidence, configure dedicated destination if absent, rehearse and review. Keep supported renamed/overwrite restore as explicit advanced administrator actions; never claim rehearsal guarantees production compatibility.
- [ ] Run all Jest tests, `npm run typecheck`, `npm run build`, both JS syntax checks and `git diff --check`; expect all PASS. Run disposable MySQL/MariaDB restore/cancellation checks only where engines/tools are available; report unrun checks and cleanup warnings. Confirm health/readiness/auth endpoints.
- [ ] Update docs with actual behavior, defaults, single-owner constraint, migrations/rollback, at-least-once notifications, aliases, FIFO, restart and recovery limits. Rollback after schema upgrade requires preserved data backup and documented version compatibility; never blindly replace a live database.
- [ ] Review the complete diff for requirement coverage and unrelated changes. Future checkpoint: `feat: guide recovery through verified rehearsals`.

## Plan review and execution

This is three independently reviewable delivery areas: durable execution (Tasks 1–4), protection/notifications (5–6), and operator/recovery workflows (7–8). Finish each area's integration checks before proceeding. Keep existing local UI changes intact throughout.

The named superpowers execution subskills and codebase-design/grilling Skill tool were not installed/exposed when execution began. The maintainer selected the available subagent workflow as a fallback. Implementation and disposable migration validation are recorded below. No commit, push or release is authorized by this plan.


## Execution log

- Task 1: implemented and independently reviewed; nested rollback/async-callback defects repaired. Ownership/migration/PITR focused checks: 24 passing. Initial red-run evidence not retained. Single-writer locks intentionally fail closed for ambiguous/abandoned gates; Windows power-loss durability is unproven.
- Task 2: implemented and independently reviewed; full suite at this checkpoint: 63 passing tests. Immutable pair snapshots, selective retry and pre-retention artifact persistence verified.
- Task 3: admission implementation reviewed; startup failure on deleted source and slow sparse cron repaired. Reviewer measured annual cron 13.2 ms and impossible February 31 0.7 ms after repair. Legacy endpoint completed-response compatibility is explicitly reserved for Task 7; current queued acknowledgements must not be shipped as completion. Historical retry-limit correction completed; 12 queue tests passed. Task 3 admission accepted; endpoint completion-response compatibility remains Task 7 work.

- Task 7 integration finding: StorageService.health computes freeBytes but healthSummary omits it and the table does not retain it. Persist and return the sampled free bytes with checkedAt (nullable for unsupported providers) so the existing Overview estimate can use real health evidence after reload. Add a round-trip regression test; never substitute application-volume capacity for remote destinations.

- Task 4: implemented and independently reviewed; partial retention acknowledgement, view cancellation, provider signals and interruption aggregation repaired. Added direct lifecycle fixtures for child/output races, escalation, stream closure, native query destruction, cancelled restart and ownership-held drain. Five focused suites/51 tests passed; live OS/provider checks remain later integration work.
- Task 5: implemented and independently reviewed; malformed pair configuration is isolated as unknown, future unverified artifacts preserve clock uncertainty, and policy-only changes never emit false recovery. Protection suite 14/14 passing. Shared snapshot normalization is now used by admission and protection.

- Task 6: implemented and independently reviewed. Durable event materialization, grouped/superseded intents, provider timeouts/backoff, preference preservation and scoped manual-retry recovery verified by 19 focused tests. No real notification provider contacted.
- Task 7: implemented and independently reviewed. Added session/CSRF/admin boundaries, async UI endpoints alongside completed-response legacy adapters, revocation-aware SSE, source group membership replacement, independent queue/history loading and stale-response guards. Fixed artifact/execution ID mismatch in historical retry. Browser validation found and repaired nested recovery action spacing and long-content overflow.
- Task 8: implemented and independently reviewed. Dedicated artifact evidence, isolated multi-database scratch restore, collision/hash/manifest/object checks, cleanup despite evidence-write failure, UTF-8-safe rewrite, disabled native client commands, and streamed SQL comment/string context were verified. A live MariaDB table archive exposed the truncated-comment validator defect; a regression test now covers it.
- Integration checkpoint: 24 suites / 173 tests passed before the final streamed-comment and terminal-stage regressions were added; typecheck/build/both JavaScript syntax checks/diff check passed. Disposable MariaDB six-pair execution produced five successes and one deliberate upload failure; a one-pair child retry succeeded. Independent live checks verified multi-database gzip/database archives, actual portable dump cancellation, legacy response compatibility, missing-CSRF/anonymous rejection and scratch cleanup. Final validation totals and platform limits are reported in the completion message.
- Validation limits: a genuine MySQL server, Linux process behavior, real external storage providers and real notification delivery are unavailable or deliberately outside local test scope. The MariaDB mysqld alias is not a MySQL server. No existing DATA_DIR was opened or cleared for this work.
- Final verification: 24 suites / 177 tests passed; typecheck, build, both JavaScript syntax checks and diff check passed. Final rebuilt live MariaDB checks passed three-database backup/rehearsal for all three layouts, with no scratch databases remaining. Viewer authorization and revoked-session SSE closure passed. Browser checks covered both themes at 390/768/1440px; fixed overflow and Escape/focus behavior, with no browser errors observed. All disposable servers stopped. Automatic approval review blocked removal of temporary fixture folders; they remain under Windows Temp, separately from the real application data.
