import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrorResponses, ApiExampleResponse } from '../common/swagger-responses';
import { AuthService } from '../auth/auth.service';
import { RecoveryPlanDto, RecoveryConnectionDto, FleetEnrollmentDto, PitrCaptureDto } from '../common/request-dtos';
import { RecoveryService } from './recovery.service';

@Controller('api/recovery')
@ApiTags('Recovery assurance and resilience')
@ApiCookieAuth('vb_session')
@ApiCommonErrorResponses()
export class RecoveryController {
  constructor(private readonly auth: AuthService, private readonly recovery: RecoveryService) {}
  @Get('dashboard')
  @ApiOperation({ summary: 'Read recovery assurance, policy findings, PITR status, and recent tests.' })
  @ApiExampleResponse(200, 'Recovery assurance dashboard.', { plans: [], tests: [], policy: { summary: { critical: 0, high: 0, medium: 1, ready: 0 }, items: [] }, pitr: { checkedAt: '2026-08-18T04:00:00.000Z', items: [] } })
  async dashboard(@Req() req: FastifyRequest) { const session = this.auth.requireSession(req); return { ...this.recovery.snapshot(), pitr: session.role === 'admin' ? await this.recovery.pitrStatus() : { checkedAt: null, items: [] }, runbooks: this.recovery.runbooks() }; }
  @Get('plans') plans(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.recovery.listPlans(); }
  @Get('connections')
  @ApiOperation({ summary: 'List dedicated database servers available for isolated recovery tests. Administrator only.' })
  @ApiExampleResponse(200, 'Dedicated recovery connections. Passwords are never returned.', [{ id: 'recovery_conn_01HXYZ123', name: 'Disaster recovery MySQL', engine: 'mysql', host: '10.0.20.15', port: 3306, username: 'vaultback_restore', ssl: true, createdAt: '2026-08-18T04:00:00.000Z' }])
  connections(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.recovery.listRecoveryConnections(); }
  @Post('connections')
  @ApiOperation({ summary: 'Create or update a dedicated encrypted recovery database server.' })
  @ApiExampleResponse(201, 'Dedicated recovery connection saved. The password is encrypted and omitted.', { id: 'recovery_conn_01HXYZ123', name: 'Disaster recovery MySQL', engine: 'mysql', host: '10.0.20.15', port: 3306, username: 'vaultback_restore', ssl: true, createdAt: '2026-08-18T04:00:00.000Z' })
  saveConnection(@Req() req: FastifyRequest, @Body() body: RecoveryConnectionDto) { this.auth.requireAdmin(req); return this.recovery.saveRecoveryConnection(body); }
  @Post('connections/test')
  @ApiOperation({ summary: 'Test a dedicated recovery database server before saving it.' })
  @ApiExampleResponse(201, 'Recovery connection test result.', { ok: true, message: 'Database connection successful' })
  testConnection(@Req() req: FastifyRequest, @Body() body: RecoveryConnectionDto) { this.auth.requireAdmin(req); return this.recovery.testRecoveryConnection(body); }
  @Delete('connections/:id')
  @ApiOperation({ summary: 'Delete a dedicated recovery database server not used by a plan.' })
  @ApiExampleResponse(200, 'Recovery connection deleted.', { ok: true })
  deleteConnection(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.recovery.deleteRecoveryConnection(id); }
  @Post('plans') savePlan(@Req() req: FastifyRequest, @Body() body: RecoveryPlanDto) { this.auth.requireAdmin(req); return this.recovery.savePlan(body); }
  @Delete('plans/:id') deletePlan(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.recovery.deletePlan(id); }
  @Post('plans/:id/run') runTest(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.recovery.runTest(id); }
  @Get('tests') tests(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.recovery.listTests(); }
  @Get('pitr') pitr(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.recovery.pitrStatus(); }
  @Post('pitr/capture')
  @ApiOperation({ summary: 'Capture the currently available raw binary logs to a storage target.' })
  @ApiExampleResponse(201, 'Raw binary-log capture result. This does not apply logs to a destination.', { ok: true, captured: 2, warning: 'This captures raw binlog files for later PITR processing. VaultBack does not apply binlogs to a destination automatically yet.' })
  capturePitr(@Req() req: FastifyRequest, @Body() body: PitrCaptureDto) { this.auth.requireAdmin(req); return this.recovery.capturePitr(body.connectionId, body.storageTargetId); }
  @Get('runbooks') runbooks(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.recovery.runbooks(); }
  @Get('fleet') fleet(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.recovery.listFleet(); }
  @Post('fleet/enroll') enroll(@Req() req: FastifyRequest, @Body() body: FleetEnrollmentDto) { this.auth.requireAdmin(req); return this.recovery.enrollFleet(body); }
  @Post('fleet/:id/revoke') revoke(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.recovery.revokeFleet(id); }
}
