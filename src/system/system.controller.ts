import { Controller, Get, Post, Body, Req, Res, ForbiddenException } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service';
import { SystemService } from './system.service';
import { EnvironmentDto, FullExportDto, FullImportDto, NotificationDto } from '../common/request-dtos';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

@Controller('api/settings')
@ApiTags('System settings, updates, and administration')
@ApiCookieAuth('vb_session')
export class SystemController {
  constructor(private readonly system: SystemService, private readonly auth: AuthService) {}
  @Get('notifications')
  @ApiOperation({ summary: 'Read notification settings.' })
  notifications(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.system.getNotificationSettings(); }
  @Post('notifications')
  @ApiOperation({ summary: 'Save notification provider and event settings.' })
  saveNotifications(@Req() req: FastifyRequest, @Body() body: NotificationDto) { const session = this.auth.requireAdmin(req); const result = this.system.saveNotificationSettings(body); this.system.audit(session.user_id, 'settings.notifications.update'); return result; }
  @Get('capacity')
  @ApiOperation({ summary: 'Read application storage capacity information.' })
  capacity(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.system.capacity(); }
  @Get('environment')
  @ApiOperation({ summary: 'Read the configured runtime environment.' })
  environment(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.system.environmentSettings(); }
  @Post('environment')
  @ApiOperation({ summary: 'Change development or production mode. Primary administrator only.' })
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
  setup(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.system.setupStatus(); }
  @Get('rate-limit-usage')
  @ApiOperation({ summary: 'List current API request usage by client IP.' })
  rateLimitUsage(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.system.listApiUsage((req as any).query || {}); }
  @Get('audit')
  @ApiOperation({ summary: 'List administrator audit events.' })
  audit(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.system.listAudit((req as any).query || {}); }
  @Get('export')
  @ApiOperation({ summary: 'Export configuration without secret values.' })
  exportConfig(@Req() req: FastifyRequest) { const session = this.auth.requireAdmin(req); this.system.audit(session.user_id, 'config.export'); return this.system.exportSafeConfig(); }
  @Post('export/full')
  @ApiOperation({ summary: 'Export an encrypted full configuration package.' })
  fullExport(@Req() req: FastifyRequest, @Body() body: FullExportDto, @Res() reply: FastifyReply) { const session = this.auth.requireAdmin(req); const result = this.system.fullExport(String(body.password || '')); this.system.audit(session.user_id, 'config.full_export'); reply.header('Content-Disposition', 'attachment; filename="vaultback-encrypted-export.json"'); reply.type('application/json'); return reply.send(JSON.stringify(result)); }
  @Post('import/full')
  @ApiOperation({ summary: 'Import an encrypted full configuration package.' })
  fullImport(@Req() req: FastifyRequest, @Body() body: FullImportDto) { const session = this.auth.requireAdmin(req); const result = this.system.importFull(body.package, String(body.password || '')); this.system.audit(session.user_id, 'config.full_import'); return result; }
  @Post('restart')
  @ApiOperation({ summary: 'Request a graceful application restart through the supervisor.' })
  restart(@Req() req: FastifyRequest, @Res() reply: FastifyReply) { const session = this.auth.requireAdmin(req, true); return reply.code(202).send(this.system.requestRestart(session.user_id)); }
  @Get('update')
  @ApiOperation({ summary: 'Read current and available software release information.' })
  updateInfo(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.system.updateInfo(); }
  @Post('update/check')
  @ApiOperation({ summary: 'Check the configured release manifest for updates.' })
  checkUpdate(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.system.checkForUpdate(); }
  @Post('update/install')
  @ApiOperation({ summary: 'Start a verified software update.' })
  installUpdate(@Req() req: FastifyRequest, @Res() reply: FastifyReply) { const session = this.auth.requireAdmin(req, true); return reply.code(202).send(this.system.startUpdate(session.user_id)); }
}
