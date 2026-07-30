import { Controller, Get, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthService } from './auth/auth.service';
import { BackupService } from './backup/backup.service';
import { SystemService } from './system/system.service';
import { DatabaseService } from './database/database.service';

@Controller('api')
export class AppController {
  constructor(private readonly auth: AuthService, private readonly backups: BackupService, private readonly system: SystemService, private readonly store: DatabaseService) {}
  @Get('health') health() { return { ok: true, service: 'vaultback', version: this.system.getAppVersion(), time: new Date().toISOString() }; }
  @Get('health/details') healthDetails(@Req() req: FastifyRequest) { this.auth.requireSession(req); const encryption = this.store.encryptionStatus(); return { ok: encryption.status !== 'error', service: 'vaultback', time: new Date().toISOString(), encryption, dependencies: this.backups.dependencyStatus(), capacity: this.system.capacity() }; }
  @Get('overview') overview(@Req() req: FastifyRequest) { this.auth.requireSession(req); return { ok: true }; }
}
