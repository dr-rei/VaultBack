import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { environmentName, isProductionEnvironment, rateLimitPerMinute } from '../common/app-config';
import { DatabaseService } from '../database/database.service';

export type NotificationEvent = 'backup_success' | 'backup_failed' | 'capacity_warning';

@Injectable()
export class SystemService {
  private readonly logger = new Logger(SystemService.name);
  private readonly apiUsage = new Map<string, { windowStart: number; count: number; lastSeen: number }>();
  constructor(private readonly store: DatabaseService) {}

  private configuredRateLimit() {
    return rateLimitPerMinute();
  }

  private readSetting<T>(key: string, fallback: T): T {
    const row = this.store.db.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as { value?: string } | undefined;
    if (!row?.value) return fallback;
    try { return this.store.decrypt<T>(row.value); } catch { return fallback; }
  }

  private writeSetting(key: string, value: unknown) {
    this.store.db.prepare('INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, this.store.encrypt(value));
  }

  getNotificationSettings() {
    const config = this.readSetting<any>('notification_settings', { enabled: false, provider: 'discord', webhookUrl: '', botToken: '', chatId: '', events: { backup_success: false, backup_failed: true, capacity_warning: true } });
    return { enabled: Boolean(config.enabled), provider: config.provider || 'discord', webhookConfigured: Boolean(config.webhookUrl || config.botToken), events: config.events || {} };
  }

  saveNotificationSettings(input: any) {
    const provider = ['discord', 'telegram', 'generic'].includes(input.provider) ? input.provider : 'discord';
    if (input.enabled && provider !== 'telegram' && !String(input.webhookUrl || '').startsWith('https://')) throw new BadRequestException('Use an HTTPS webhook URL');
    if (input.enabled && provider === 'telegram' && (!input.botToken || !input.chatId)) throw new BadRequestException('Telegram bot token and chat ID are required');
    const old = this.readSetting<any>('notification_settings', {});
    const secret = (next: unknown, previous: unknown) => String(next || '').trim() || String(previous || '');
    const value = { enabled: Boolean(input.enabled), provider, webhookUrl: String(input.webhookUrl || '').trim(), webhookToken: secret(input.webhookToken, old.webhookToken), botToken: secret(input.botToken, old.botToken), chatId: String(input.chatId || '').trim(), events: { backup_success: Boolean(input.events?.backup_success), backup_failed: input.events?.backup_failed !== false, capacity_warning: input.events?.capacity_warning !== false } };
    this.writeSetting('notification_settings', value);
    return this.getNotificationSettings();
  }

  async notify(event: NotificationEvent, message: string) {
    const config = this.readSetting<any>('notification_settings', {});
    if (!config.enabled || config.events?.[event] === false) return;
    try {
      if (config.provider === 'telegram') {
        await fetch(`https://api.telegram.org/bot${encodeURIComponent(config.botToken)}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: config.chatId, text: message }) });
        return;
      }
      const body = config.provider === 'discord' ? { content: message } : { event, message, service: 'vaultback' };
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (config.webhookToken) headers.authorization = `Bearer ${config.webhookToken}`;
      await fetch(String(config.webhookUrl), { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (error: any) {
      this.logger.warn(`Notification delivery failed: ${String(error?.message || error).slice(0, 240)}`);
    }
  }

  capacity() {
    const locations = [{ name: 'Application data', path: this.store.dataDir }, { name: 'Local backups', path: path.join(this.store.dataDir, 'backups') }];
    return locations.map(location => {
      try {
        fs.mkdirSync(location.path, { recursive: true });
        const stat = (fs as any).statfsSync(location.path);
        const totalBytes = Number(stat.blocks) * Number(stat.bsize); const freeBytes = Number(stat.bavail) * Number(stat.bsize);
        return { name: location.name, totalBytes, freeBytes, usedPercent: totalBytes ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0 };
      } catch { return { name: location.name, totalBytes: null, freeBytes: null, usedPercent: null }; }
    });
  }

  setupStatus() {
    const counts = {
      connections: Number((this.store.db.prepare('SELECT COUNT(*) as count FROM database_connections').get() as any)?.count || 0),
      storage: Number((this.store.db.prepare('SELECT COUNT(*) as count FROM storage_targets').get() as any)?.count || 0),
      schedules: Number((this.store.db.prepare('SELECT COUNT(*) as count FROM backup_jobs').get() as any)?.count || 0)
    };
    return { ...counts, complete: counts.connections > 0 && counts.storage > 0 && counts.schedules > 0 };
  }

  recordApiRequest(request: { ip?: string; socket?: { remoteAddress?: string } }) {
    const now = Date.now();
    const windowStart = Math.floor(now / 60000) * 60000;
    const ip = String(request.ip || request.socket?.remoteAddress || 'unknown').trim() || 'unknown';
    const current = this.apiUsage.get(ip);
    const entry = current?.windowStart === windowStart ? current : { windowStart, count: 0, lastSeen: now };
    entry.count += 1;
    entry.lastSeen = now;
    this.apiUsage.set(ip, entry);
    this.pruneApiUsage(now, windowStart);
  }

  listApiUsage(input: any = {}) {
    const now = Date.now();
    const windowStart = Math.floor(now / 60000) * 60000;
    this.pruneApiUsage(now, windowStart);
    const page = Math.max(1, Number.parseInt(String(input.page || '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(10, Number.parseInt(String(input.pageSize || '25'), 10) || 25));
    const all = [...this.apiUsage.entries()]
      .filter(([, entry]) => entry.windowStart === windowStart)
      .sort((a, b) => b[1].count - a[1].count || b[1].lastSeen - a[1].lastSeen);
    const total = all.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pageCount);
    const limit = this.configuredRateLimit();
    const resetAt = new Date(windowStart + 60000).toISOString();
    return {
      enabled: isProductionEnvironment(),
      environment: environmentName(),
      windowStartedAt: new Date(windowStart).toISOString(),
      resetAt,
      limit,
      items: all.slice((safePage - 1) * pageSize, safePage * pageSize).map(([ip, entry]) => ({ ip, requests: entry.count, remaining: Math.max(0, limit - entry.count), limit, resetAt })),
      total,
      page: safePage,
      pageSize,
      pageCount
    };
  }

  private pruneApiUsage(now: number, currentWindow: number) {
    for (const [ip, entry] of this.apiUsage) if (entry.windowStart !== currentWindow || now - entry.lastSeen > 120000) this.apiUsage.delete(ip);
    if (this.apiUsage.size <= 2000) return;
    const oldest = [...this.apiUsage.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [ip] of oldest.slice(0, this.apiUsage.size - 2000)) this.apiUsage.delete(ip);
  }

  exportSafeConfig() {
    const connections = this.store.db.prepare('SELECT id,name,engine,host,port,username,database_name as database,database_scope as databaseScope,database_names as databases,ssl,created_at as createdAt FROM database_connections ORDER BY name').all();
    const storage = this.store.db.prepare('SELECT id,name,type,created_at as createdAt FROM storage_targets ORDER BY name').all();
    const jobs = this.store.db.prepare('SELECT id,name,database_connection_id as databaseConnectionId,storage_target_id as storageTargetId,database_scope as databaseScope,database_names as databases,backup_layout as backupLayout,cron_expression as cronExpression,timezone,enabled,compression,backup_encryption as backupEncryption,retention_count as retentionCount,filename_prefix as filenamePrefix,created_at as createdAt FROM backup_jobs ORDER BY name').all();
    return { exportedAt: new Date().toISOString(), warning: 'Secrets are intentionally excluded. Re-enter credentials after importing.', connections, storage, jobs };
  }

  fullExport(password: string) {
    this.requireExportPassword(password);
    const database = fs.readFileSync(this.store.databaseFilePath());
    const payload = Buffer.from(JSON.stringify({ format: 'vaultback-full-export', version: 1, exportedAt: new Date().toISOString(), database: database.toString('base64url'), encryptionKey: this.store.encryptionKeyValue() }), 'utf8');
    const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12); const key = this.exportKey(password, salt); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from('vaultback-full-export-v1'));
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    return { format: 'vaultback-encrypted-export', version: 1, kdf: 'scrypt', salt: salt.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
  }

  importFull(input: any, password: string) {
    this.requireExportPassword(password); const envelope = typeof input === 'string' ? JSON.parse(input) : input;
    if (!envelope || envelope.format !== 'vaultback-encrypted-export' || envelope.version !== 1) throw new BadRequestException('Unsupported VaultBack export package');
    try {
      const salt = Buffer.from(String(envelope.salt), 'base64url'); const iv = Buffer.from(String(envelope.iv), 'base64url'); const tag = Buffer.from(String(envelope.tag), 'base64url'); const ciphertext = Buffer.from(String(envelope.ciphertext), 'base64url');
      if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || !ciphertext.length || ciphertext.length > 50 * 1024 * 1024) throw new Error('Invalid encrypted package');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.exportKey(password, salt), iv); decipher.setAAD(Buffer.from('vaultback-full-export-v1')); decipher.setAuthTag(tag); const decoded = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) as any;
      const database = Buffer.from(String(decoded.database || ''), 'base64url'); const encryptionKey = String(decoded.encryptionKey || '').trim(); if (database.subarray(0, 16).toString('utf8') !== 'SQLite format 3\0' || database.length < 100 || !/^[a-zA-Z0-9_-]{32,256}$/.test(encryptionKey)) throw new Error('The package does not contain a valid VaultBack database and encryption key');
      this.store.stageImportedDatabase(database, encryptionKey); return { ok: true, requiresRestart: true, message: 'Encrypted configuration staged. Restart VaultBack to activate the imported configuration.' };
    } catch (error: any) { if (error instanceof BadRequestException) throw error; throw new BadRequestException(`Could not decrypt the export package. Check the export password. ${String(error?.message || '').slice(0, 160)}`); }
  }

  private requireExportPassword(password: string) { if (typeof password !== 'string' || password.length < 12) throw new BadRequestException('Use an export password of at least 12 characters'); }
  private exportKey(password: string, salt: Buffer) { return crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }); }

  requestRestart(userId: string) {
    this.audit(userId, 'system.restart');
    const timer = setTimeout(() => {
      try { process.kill(process.pid, 'SIGTERM'); } catch (error: any) { this.logger.error(`Restart request failed: ${String(error?.message || error)}`); }
    }, 350);
    timer.unref?.();
    return { ok: true, message: 'Restart requested. The service manager should bring VaultBack back online shortly.' };
  }

  audit(userId: string | null, action: string, entityType?: string, entityId?: string, metadata?: unknown) {
    this.store.db.prepare('INSERT INTO audit_logs (id,user_id,action,entity_type,entity_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)').run(crypto.randomUUID(), userId, action, entityType || null, entityId || null, metadata ? JSON.stringify(metadata) : null, this.store.now());
  }
}
