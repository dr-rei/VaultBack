import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { ConfigurationSnapshot, selectionFingerprint, snapshotConfiguration } from './execution.types';

export interface ProtectionAssessment {
  jobId: string; connectionId: string; storageTargetId: string; required: boolean; fingerprint: string;
  latestVerifiedRunId: string | null; latestVerifiedAt: string | null;
  freshnessStatus: 'fresh' | 'stale' | 'grace' | 'unknown' | 'paused';
  missedStartStatus: 'on_time' | 'missed' | 'unknown' | 'paused';
  longRunningStatus: 'normal' | 'long_running' | 'unknown' | 'paused';
  evidence: { reason: string; graceUntil: string | null; latestOutcome: string | null; latestVerificationStatus: string | null; scheduledFor: string | null; runningSince: string | null; clockRollback: boolean };
}

@Injectable()
export class ProtectionService {
  constructor(private readonly database: DatabaseService) {}

  assess(now: Date): ProtectionAssessment[] {
    const db = this.database.db; const time = now.getTime(); const assessments: ProtectionAssessment[] = [];
    for (const job of db.prepare('SELECT * FROM backup_jobs').all() as any[]) {
      const connections = db.prepare('SELECT connection_id,database_names FROM backup_job_connections WHERE job_id=?').all(job.id) as any[];
      const targets = db.prepare('SELECT storage_target_id,required FROM backup_job_storages WHERE job_id=?').all(job.id) as any[];
      if (!connections.length) connections.push({connection_id:job.database_connection_id,database_names:job.database_names});
      if (!targets.length) targets.push({storage_target_id:job.storage_target_id,required:1});
      for (const connection of connections) for (const target of targets) {
        const source = db.prepare('SELECT database_names,database_name FROM database_connections WHERE id=?').get(connection.connection_id);
        let fingerprint: string;
        try { fingerprint = selectionFingerprint(snapshotConfiguration(job,connection.database_names,source)); }
        catch {
          // Invalid persisted configuration cannot establish a protection identity.
          // Isolate this pair so one corrupt selection cannot stop the cron policy.
          assessments.push({jobId:job.id,connectionId:connection.connection_id,storageTargetId:target.storage_target_id,required:target.required !== 0,fingerprint:'invalid_configuration',latestVerifiedRunId:null,latestVerifiedAt:null,freshnessStatus:job.enabled ? 'unknown' : 'paused',missedStartStatus:job.enabled ? 'unknown' : 'paused',longRunningStatus:job.enabled ? 'unknown' : 'paused',evidence:{reason:'Invalid persisted backup selection configuration',graceUntil:null,latestOutcome:null,latestVerificationStatus:null,scheduledFor:null,runningSince:null,clockRollback:false}});
          continue;
        }
        const pairs = db.prepare('SELECT p.*,e.scheduled_for,e.queued_at,e.trigger,e.status as execution_status FROM backup_execution_pairs p JOIN backup_executions e ON e.id=p.execution_id WHERE e.job_id=? AND p.connection_id=? AND p.storage_target_id=? AND p.fingerprint=? ORDER BY e.queued_at DESC').all(job.id,connection.connection_id,target.storage_target_id,fingerprint) as any[];
        const runs = db.prepare('SELECT * FROM backup_runs WHERE job_id=? AND database_connection_id=? AND storage_target_id=? ORDER BY finished_at DESC').all(job.id,connection.connection_id,target.storage_target_id) as any[];
        const matching = runs.filter(run => this.matches(run,fingerprint));
        const verified = matching.filter(run => run.status === 'success' && run.verification_status === 'passed' && Number.isFinite(Date.parse(run.finished_at)));
        let future = matching.some(run => Date.parse(run.finished_at) > time || Date.parse(run.started_at) > time) || pairs.some(pair => Date.parse(pair.queued_at) > time) || Date.parse(job.created_at) > time;
        const latest = verified.find(run => Date.parse(run.finished_at) <= time);
        const graceUntil = Date.parse(job.created_at) + job.max_verified_age_hours * 3600000;
        // No history gets a full freshness window from schedule creation. A changed
        // configuration gets no inherited clock or artificial grace from old runs.
        const hasHistory = runs.length > 0 || pairs.length > 0;
        let freshnessStatus: ProtectionAssessment['freshnessStatus'] = latest ? (time - Date.parse(latest.finished_at) >= job.max_verified_age_hours * 3600000 ? 'stale' : 'fresh') : (!hasHistory || matching.length > 0 || pairs.length > 0) && time < graceUntil ? 'grace' : hasHistory && matching.length === 0 && pairs.length === 0 ? 'unknown' : 'stale';
        const scheduled = pairs.filter(pair => pair.scheduled_for && ['scheduled','catchup'].includes(pair.trigger)).sort((a,b) => Date.parse(b.scheduled_for) - Date.parse(a.scheduled_for));
        const latestOccurrence = scheduled[0];
        const missed = latestOccurrence && !latestOccurrence.started_at && latestOccurrence.status === 'queued' && time - Date.parse(latestOccurrence.scheduled_for) >= job.missed_start_grace_minutes * 60000 ? latestOccurrence : null;
        const due = job.next_run_at && time - Date.parse(job.next_run_at) >= job.missed_start_grace_minutes * 60000 ? job.next_run_at : null;
        const active = pairs.filter(pair => ['running','cancel_requested'].includes(pair.status));
        const activeAttempts = active.map(pair => db.prepare("SELECT started_at FROM backup_execution_attempts WHERE pair_id=? AND status='running' ORDER BY attempt_number DESC LIMIT 1").get(pair.id) as any).filter(Boolean);
        future ||= activeAttempts.some(attempt => Date.parse(attempt.started_at) > time);
        const running = activeAttempts.find(attempt => time - Date.parse(attempt.started_at) >= job.long_running_warning_minutes * 60000);
        let missedStartStatus: ProtectionAssessment['missedStartStatus'] = missed || due ? 'missed' : 'on_time';
        let longRunningStatus: ProtectionAssessment['longRunningStatus'] = running ? 'long_running' : 'normal';
        if (future) { freshnessStatus = 'unknown'; missedStartStatus = 'unknown'; longRunningStatus = 'unknown'; }
        if (!job.enabled) { freshnessStatus = 'paused'; missedStartStatus = 'paused'; longRunningStatus = 'paused'; }
        assessments.push({jobId:job.id,connectionId:connection.connection_id,storageTargetId:target.storage_target_id,required:target.required !== 0,fingerprint,latestVerifiedRunId:latest?.id || null,latestVerifiedAt:latest?.finished_at || null,freshnessStatus,missedStartStatus,longRunningStatus,evidence:{reason:future ? 'Future-dated evidence: clock rollback or invalid timestamps' : latest ? 'Verified artifact with matching recorded configuration' : !hasHistory ? 'No history: freshness grace starts at schedule creation' : 'No verified artifact proves the current configuration',graceUntil:!hasHistory && Number.isFinite(graceUntil) ? new Date(graceUntil).toISOString() : null,latestOutcome:matching[0]?.status || pairs[0]?.status || null,latestVerificationStatus:matching[0]?.verification_status || null,scheduledFor:missed?.scheduled_for || due || null,runningSince:running?.started_at || null,clockRollback:future}});
      }
    }
    return assessments;
  }

  private matches(run: any, fingerprint: string): boolean {
    const fields = ['database_scope','database_names','backup_layout','backup_objects','insert_mode','compression','backup_encryption'];
    if (fields.some(field => run[field] === null || run[field] === undefined)) return false;
    try {
      const objects = JSON.parse(run.backup_objects);
      if (['views','routines','triggers','events'].some(key => typeof objects[key] !== 'boolean')) return false;
      return selectionFingerprint({...run,backup_objects:objects} as ConfigurationSnapshot) === fingerprint;
    } catch { return false; }
  }

  evaluateIncidents(now: Date): void {
    const assessments = this.assess(now); const db = this.database.db; const stamp = now.toISOString();
    db.transaction(() => {
      const open = db.prepare("SELECT * FROM protection_incidents WHERE status='open'").all() as any[];
      const active = new Set<string>();
      for (const assessment of assessments) {
        for (const [kind,status,bad] of [['freshness',assessment.freshnessStatus,'stale'],['missed_start',assessment.missedStartStatus,'missed'],['long_running',assessment.longRunningStatus,'long_running']]) {
          const key = JSON.stringify([assessment.jobId,assessment.connectionId,assessment.storageTargetId,assessment.fingerprint,kind]);
          const existing = open.find(item => JSON.stringify([item.job_id,item.connection_id,item.storage_target_id,item.fingerprint,item.kind]) === key);
          // Pausing/unknown evidence preserves existing incidents without generating transitions.
          if (!assessment.required) continue;
          if (status === 'paused' || status === 'unknown') { if (existing) active.add(existing.id); continue; }
          if (status !== bad || !assessment.required) continue;
          if (existing) { active.add(existing.id); continue; }
          const id = crypto.randomUUID(); active.add(id);
          db.prepare('INSERT INTO protection_incidents(id,job_id,connection_id,storage_target_id,fingerprint,kind,opened_at,updated_at,evidence_json) VALUES (?,?,?,?,?,?,?,?,?)').run(id,assessment.jobId,assessment.connectionId,assessment.storageTargetId,assessment.fingerprint,kind,stamp,stamp,JSON.stringify(assessment));
          this.event('protection_incident_opened',id,assessment,stamp);
        }
      }
      for (const incident of open) if (!active.has(incident.id)) {
        const invalid = assessments.find(item => item.jobId === incident.job_id && item.connectionId === incident.connection_id && item.storageTargetId === incident.storage_target_id && item.fingerprint === 'invalid_configuration');
        if (invalid?.required) continue;
        db.prepare("UPDATE protection_incidents SET status='resolved',updated_at=?,resolved_at=? WHERE id=? AND status='open'").run(stamp,stamp,incident.id);
        const current = assessments.find(item => item.jobId === incident.job_id && item.connectionId === incident.connection_id && item.storageTargetId === incident.storage_target_id);
        const reason = !current ? 'configuration_removed' : current.fingerprint !== incident.fingerprint ? 'configuration_changed' : !current.required ? 'destination_optional' : 'condition_cleared';
        this.event(reason === 'condition_cleared' ? 'protection_incident_resolved' : 'protection_incident_closed',incident.id,{reason,jobId:incident.job_id,connectionId:incident.connection_id,storageTargetId:incident.storage_target_id,fingerprint:incident.fingerprint,kind:incident.kind},stamp);
      }
    });
  }
  private event(kind: string, incidentId: string, assessment: unknown, stamp: string) {
    this.database.db.prepare('INSERT INTO execution_events(id,kind,payload_json,created_at) VALUES (?,?,?,?)').run(crypto.randomUUID(),kind,JSON.stringify({incidentId,assessment}),stamp);
  }
}
