import { Controller, Get, Post, Body, Req, Res, ForbiddenException } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service';
import { SystemService } from './system.service';
import { EnvironmentDto, FullExportDto, FullImportDto, NotificationDto } from '../common/request-dtos';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAcceptedExample, ApiCommonErrorResponses, ApiExampleResponse } from '../common/swagger-responses';

@Controller('api/settings')
@ApiTags('System settings, updates, and administration')
@ApiCookieAuth('vb_session')
@ApiCommonErrorResponses()
export class SystemController {
  constructor(private readonly system: SystemService, private readonly auth: AuthService) {}
  @Get('notifications')
  @ApiOperation({ summary: 'Read notification settings.' })
  @ApiExampleResponse(200, 'Notification settings without secret values.', { enabled: true, provider: 'discord', webhookConfigured: true, events: { backup_success: true, backup_failed: true, backup_retry: true, backup_stale: false, storage_failed: true, capacity_warning: true } })
  notifications(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.system.getNotificationSettings(); }
  @Post('notifications')
  @ApiOperation({ summary: 'Save notification provider and event settings.' })
  @ApiExampleResponse(201, 'Notification settings saved. Secret values are not returned.', { enabled: true, provider: 'discord', webhookConfigured: true, events: { backup_success: true, backup_failed: true, backup_retry: true, backup_stale: false, storage_failed: true, capacity_warning: true } })
  saveNotifications(@Req() req: FastifyRequest, @Body() body: NotificationDto) { const session = this.auth.requireAdmin(req); const result = this.system.saveNotificationSettings(body); this.system.audit(session.user_id, 'settings.notifications.update'); return result; }
  @Get('capacity')
  @ApiOperation({ summary: 'Read application storage capacity information.' })
  @ApiExampleResponse(200, 'Application and local backup capacity.', [{ name: 'Application data', path: './data', totalBytes: 100000000000, freeBytes: 65000000000, usedPercent: 35 }, { name: 'Local backups', path: './data/backups', totalBytes: 100000000000, freeBytes: 65000000000, usedPercent: 35 }])
  capacity(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.system.capacity(); }
  @Get('environment')
  @ApiOperation({ summary: 'Read the configured runtime environment.' })
  @ApiExampleResponse(200, 'Current and configured runtime environment.', { currentEnvironment: 'production', configuredEnvironment: 'production', pendingRestart: false, productionProtections: true, requiresRestart: true })
  environment(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.system.environmentSettings(); }
  @Post('environment')
  @ApiOperation({ summary: 'Change development or production mode. Primary administrator only.' })
  @ApiExampleResponse(201, 'Environment saved without restarting.', { currentEnvironment: 'development', configuredEnvironment: 'production', pendingRestart: true, productionProtections: true, requiresRestart: true, message: 'Environment saved as production. Restart VaultBack to apply it.' })
  @ApiAcceptedExample('Environment saved and restart requested.', { currentEnvironment: 'development', configuredEnvironment: 'production', pendingRestart: true, productionProtections: true, requiresRestart: true, ok: true, message: 'Environment saved as production. Restart requested.' })
  saveEnvironment(@Req() req: FastifyRequest, @Body() body: EnvironmentDto, @Res() reply: FastifyReply) {
    const session = this.auth.requireAdmin(req, true);
    if (!this.auth.isPrimaryUser(session.user_id)) throw new ForbiddenException('Only the first administrator can change the runtime environment');
    const result = this.system.saveEnvironment(body?.environment);
    this.system.audit(session.user_id, 'settings.environment.update', undefined, undefined, { environment: result.configuredEnvironment });
    if (body?.restart === true) return reply.code(202).send({ ...result, ...this.system.requestRestart(session.user_id), message: `Environment saved as ${result.configuredEnvironment}. Restart requested.` });
    return reply.send(result);
  }
  @Get('setup')
  @ApiOperation({ summary: 'Read first-run setup status.' })
  @ApiExampleResponse(200, 'Setup completion counts.', { connections: 1, storage: 1, schedules: 1, complete: true })
  setup(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.system.setupStatus(); }
  @Get('rate-limit-usage')
  @ApiOperation({ summary: 'List current API request usage by client IP.' })
  @ApiExampleResponse(200, 'Paginated per-IP API usage for the current minute.', { enabled: true, environment: 'production', windowStartedAt: '2026-08-03T07:30:00.000Z', resetAt: '2026-08-03T07:31:00.000Z', limit: 800, items: [{ ip: '192.0.2.10', requests: 42, remaining: 758, limit: 800, resetAt: '2026-08-03T07:31:00.000Z' }], total: 1, page: 1, pageSize: 25, pageCount: 1 })
  rateLimitUsage(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.system.listApiUsage((req as any).query || {}); }
  @Get('audit')
  @ApiOperation({ summary: 'List administrator audit events.' })
  @ApiExampleResponse(200, 'Paginated administrator audit events.', { items: [{ id: 'audit_01HXYZ123', action: 'settings.notifications.update', entityType: null, entityId: null, metadata: {}, createdAt: '2026-08-03T07:30:00.000Z', username: 'admin' }], total: 1, page: 1, pageSize: 25, pageCount: 1 })
  audit(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.system.listAudit((req as any).query || {}); }
  @Get('export')
  @ApiOperation({ summary: 'Export configuration without secret values.' })
  @ApiExampleResponse(200, 'Safe configuration export. Credentials and other secret values are excluded.', { exportedAt: '2026-08-03T07:30:00.000Z', warning: 'Secrets are intentionally excluded. Re-enter credentials after importing.', connections: [], storage: [], jobs: [] })
  exportConfig(@Req() req: FastifyRequest) { const session = this.auth.requireAdmin(req); this.system.audit(session.user_id, 'config.export'); return this.system.exportSafeConfig(); }
  @Post('export/full')
  @ApiOperation({ summary: 'Export an encrypted full configuration package.' })
  @ApiExampleResponse(201, 'Encrypted full configuration export package.', { format: 'vaultback-encrypted-export', version: 2, kdf: 'scrypt', salt: 'base64url-salt', iv: 'base64url-iv', tag: 'base64url-auth-tag', ciphertext: 'base64url-ciphertext' })
  fullExport(@Req() req: FastifyRequest, @Body() body: FullExportDto, @Res() reply: FastifyReply) { const session = this.auth.requireAdmin(req); const result = this.system.fullExport(String(body.password || '')); this.system.audit(session.user_id, 'config.full_export'); reply.header('Content-Disposition', 'attachment; filename="vaultback-encrypted-export.json"'); reply.type('application/json'); return reply.send(JSON.stringify(result)); }
  @Post('import/full')
  @ApiOperation({ summary: 'Import an encrypted full configuration package.' })
  @ApiExampleResponse(201, 'Encrypted configuration staged for activation after restart.', { ok: true, requiresRestart: true, message: 'Encrypted configuration staged. Restart VaultBack to activate the imported configuration.' })
  fullImport(@Req() req: FastifyRequest, @Body() body: FullImportDto) { const session = this.auth.requireAdmin(req); const result = this.system.importFull(body.package, String(body.password || '')); this.system.audit(session.user_id, 'config.full_import'); return result; }
  @Post('restart')
  @ApiOperation({ summary: 'Request a graceful application restart through the supervisor.' })
  @ApiAcceptedExample('Graceful restart requested.', { ok: true, message: 'Restart requested. The service manager should bring VaultBack back online shortly.' })
  restart(@Req() req: FastifyRequest, @Res() reply: FastifyReply) { const session = this.auth.requireAdmin(req, true); return reply.code(202).send(this.system.requestRestart(session.user_id)); }
  @Get('update')
  @ApiOperation({ summary: 'Read current and available software release information.' })
  @ApiExampleResponse(200, 'Current update status and available release notes.', { enabled: true, currentVersion: '0.1.27', channel: 'stable', latestVersion: '0.1.27', updateAvailable: false, releaseNotesUrl: null, publishedAt: null, releases: [], checkedAt: '2026-08-03T07:30:00.000Z', status: 'current', progress: 0, error: '' })
  updateInfo(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.system.updateInfo(); }
  @Post('update/check')
  @ApiOperation({ summary: 'Check the configured release manifest for updates.' })
  @ApiExampleResponse(201, 'Update manifest checked successfully.', { enabled: true, currentVersion: '0.1.27', channel: 'stable', latestVersion: '0.1.28', updateAvailable: true, releaseNotesUrl: 'https://github.com/dr-rei/VaultBack/releases/tag/v0.1.28', publishedAt: '2026-08-04T07:30:00.000Z', releases: [{ version: '0.1.28', releaseNotesUrl: 'https://github.com/dr-rei/VaultBack/releases/tag/v0.1.28', publishedAt: '2026-08-04T07:30:00.000Z' }], checkedAt: '2026-08-04T07:31:00.000Z', status: 'available', progress: 0, error: '' })
  checkUpdate(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.system.checkForUpdate(); }
  @Post('update/install')
  @ApiOperation({ summary: 'Start a verified software update.' })
  @ApiAcceptedExample('Verified update queued for the configured process supervisor.', { ok: true, state: 'queued', targetVersion: '0.1.28', message: 'Update started. The application will restart through its configured process manager.' })
  installUpdate(@Req() req: FastifyRequest, @Res() reply: FastifyReply) { const session = this.auth.requireAdmin(req, true); return reply.code(202).send(this.system.startUpdate(session.user_id)); }
}
