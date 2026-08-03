import { Controller, Get, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthService } from './auth/auth.service';
import { BackupService } from './backup/backup.service';
import { SystemService } from './system/system.service';
import { DatabaseService } from './database/database.service';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

@Controller('api')
@ApiTags('Overview and diagnostics')
@ApiCookieAuth('vb_session')
export class AppController {
  constructor(private readonly auth: AuthService, private readonly backups: BackupService, private readonly system: SystemService, private readonly store: DatabaseService) {}
  @Get('health/details')
  @ApiOperation({ summary: 'Read authenticated encryption, tool, and capacity diagnostics.' })
  healthDetails(@Req() req: FastifyRequest) { this.auth.requireSession(req); const encryption = this.store.encryptionStatus(); return { ok: encryption.status !== 'error', service: 'vaultback', time: new Date().toISOString(), encryption, dependencies: this.backups.dependencyStatus(), capacity: this.system.capacity() }; }
  @Get('overview')
  @ApiOperation({ summary: 'Check authenticated overview availability.' })
  overview(@Req() req: FastifyRequest) { this.auth.requireSession(req); return { ok: true }; }
}
