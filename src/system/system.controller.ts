import { Controller, Get, Post, Body, Req, Res, ForbiddenException } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service';
import { SystemService } from './system.service';

@Controller('api/settings')
export class SystemController {
  constructor(private readonly system: SystemService, private readonly auth: AuthService) {}
  @Get('notifications') notifications(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.system.getNotificationSettings(); }
  @Post('notifications') saveNotifications(@Req() req: FastifyRequest, @Body() body: any) { const session = this.auth.requireAdmin(req); const result = this.system.saveNotificationSettings(body); this.system.audit(session.user_id, 'settings.notifications.update'); return result; }
  @Get('capacity') capacity(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.system.capacity(); }
  @Get('environment') environment(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.system.environmentSettings(); }
  @Post('environment') saveEnvironment(@Req() req: FastifyRequest, @Body() body: any, @Res() reply: FastifyReply) {
    const session = this.auth.requireAdmin(req, true);
    if (!this.auth.isPrimaryUser(session.user_id)) throw new ForbiddenException('Only the first administrator can change the runtime environment');
    const result = this.system.saveEnvironment(body?.environment);
    this.system.audit(session.user_id, 'settings.environment.update', undefined, undefined, { environment: result.configuredEnvironment });
    if (body?.restart === true) return reply.code(202).send({ ...result, ...this.system.requestRestart(session.user_id), message: `Environment saved as ${result.configuredEnvironment}. Restart requested.` });
    return reply.send(result);
  }
  @Get('setup') setup(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.system.setupStatus(); }
  @Get('rate-limit-usage') rateLimitUsage(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.system.listApiUsage((req as any).query || {}); }
  @Get('audit') audit(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.system.listAudit((req as any).query || {}); }
  @Get('export') exportConfig(@Req() req: FastifyRequest) { const session = this.auth.requireAdmin(req); this.system.audit(session.user_id, 'config.export'); return this.system.exportSafeConfig(); }
  @Post('export/full') fullExport(@Req() req: FastifyRequest, @Body() body: any, @Res() reply: FastifyReply) { const session = this.auth.requireAdmin(req); const result = this.system.fullExport(String(body.password || '')); this.system.audit(session.user_id, 'config.full_export'); reply.header('Content-Disposition', 'attachment; filename="vaultback-encrypted-export.json"'); reply.type('application/json'); return reply.send(JSON.stringify(result)); }
  @Post('import/full') fullImport(@Req() req: FastifyRequest, @Body() body: any) { const session = this.auth.requireAdmin(req); const result = this.system.importFull(body.package, String(body.password || '')); this.system.audit(session.user_id, 'config.full_import'); return result; }
  @Post('restart') restart(@Req() req: FastifyRequest, @Res() reply: FastifyReply) { const session = this.auth.requireAdmin(req, true); return reply.code(202).send(this.system.requestRestart(session.user_id)); }
  @Get('update') updateInfo(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.system.updateInfo(); }
  @Post('update/check') checkUpdate(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.system.checkForUpdate(); }
  @Post('update/install') installUpdate(@Req() req: FastifyRequest, @Res() reply: FastifyReply) { const session = this.auth.requireAdmin(req, true); return reply.code(202).send(this.system.startUpdate(session.user_id)); }
}
