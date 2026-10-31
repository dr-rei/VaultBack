import crypto from 'node:crypto';
import { BackupObjectOptions } from '../types';
export type ExecutionTrigger = 'scheduled' | 'manual' | 'retry' | 'catchup';
export type ExecutionStatus = 'queued' | 'running' | 'cancel_requested' | 'retrying' | 'success' | 'partial_failure' | 'failed' | 'cancelled' | 'interrupted';
export type PairSelection = { connectionId: string; storageTargetId: string };
export type RequestActor = { userId: string };
export interface ConfigurationSnapshot {
  name: string; database_scope: 'all' | 'selected'; database_names: string;
  backup_layout: 'single' | 'database' | 'table'; backup_objects: BackupObjectOptions;
  insert_mode: 'extended' | 'single-row'; compression: 'none' | 'gzip' | 'zip';
  backup_encryption: 'none' | 'aes-256-gcm'; filename_prefix: string; retention_count: number;
  retry_count: number; retry_delay_seconds: number; recordPitrCoordinates: boolean;
}
export interface PairExecutionContext extends PairSelection {
  executionId: string; pairId: string; attemptId: string; attemptNumber: number; jobId: string;
  snapshot: ConfigurationSnapshot;
}
export interface PairOutcome {
  runId: string; status: 'success' | 'failed' | 'cancelled' | 'interrupted';
  failedStage?: string; error?: string; cleanupWarnings: string[];
}
export interface AttemptView {
  id: string; attemptNumber: number; status: string; runId: string | null;
  startedAt: string | null; finishedAt: string | null; failedStage: string | null;
  error: string | null; cleanupWarnings: string[];
}
export interface PairView extends PairSelection {
  sourceName?: string; targetName?: string;
  id: string; fingerprint: string; sourceGroupId: string; required: boolean; status: string;
  waitReason: string | null; queuePosition: number | null; attempts: AttemptView[];
  cleanupWarnings: string[];
}
export interface ExecutionView {
  jobName?: string;
  id: string; jobId: string; trigger: ExecutionTrigger; status: ExecutionStatus; scheduledFor: string | null;
  queuedAt: string; startedAt: string | null; finishedAt: string | null; parentExecutionId: string | null;
  pairs: PairView[]; cleanupWarnings: string[];
}

export function selectionFingerprint(s: ConfigurationSnapshot): string {
  const names = s.database_scope === 'all' ? [] : [...new Set(parseDatabaseNames(s.database_names))].sort();
  return crypto.createHash('sha256').update(JSON.stringify([s.database_scope,names,s.backup_layout,
    [s.backup_objects.views,s.backup_objects.routines,s.backup_objects.triggers,s.backup_objects.events],
    s.insert_mode,s.compression,s.backup_encryption])).digest('hex');
}

/** Shared non-secret configuration normalization for admission and protection policy. */
export function snapshotConfiguration(job: any, databaseNames: string, source: any, recordPitrCoordinates = false): ConfigurationSnapshot {
  let names = parseDatabaseNames(databaseNames || '[]');
  if (!names.length && source) { names = parseDatabaseNames(source.database_names || '[]'); if (!names.length) names = String(source.database_name || '').split(',').map((name: string) => name.trim()).filter(Boolean); }
  const layout = ['database','table'].includes(job.backup_layout) ? job.backup_layout : 'single';
  let objects: any; try { objects = JSON.parse(job.backup_objects || '{}'); } catch { objects = {}; }
  return { name: job.name, database_scope: job.database_scope === 'all' ? 'all' : 'selected', database_names: JSON.stringify([...new Set(names)].sort()), backup_layout: layout, backup_objects: { views: objects.views === undefined ? layout !== 'table' : Boolean(objects.views), routines: objects.routines === undefined ? layout !== 'table' : Boolean(objects.routines), triggers: objects.triggers === undefined ? true : Boolean(objects.triggers), events: objects.events === undefined ? layout !== 'table' : Boolean(objects.events) }, insert_mode: job.insert_mode === 'single-row' ? 'single-row' : 'extended', compression: layout === 'single' ? job.compression : 'zip', backup_encryption: job.backup_encryption, filename_prefix: job.filename_prefix, retention_count: job.retention_count, retry_count: job.retry_count, retry_delay_seconds: job.retry_delay_seconds, recordPitrCoordinates };
}

/** Reject corrupt persisted selections instead of silently changing backup scope. */
function parseDatabaseNames(value: string): string[] {
  let names: unknown;
  try { names = JSON.parse(value); } catch { throw new Error('Invalid persisted database names: expected a JSON array of strings'); }
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw new Error('Invalid persisted database names: expected a JSON array of strings');
  return names;
}
