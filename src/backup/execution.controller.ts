import { BadRequestException, Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { AuthService } from '../auth/auth.service';
import { ExecutionService } from './execution.service';
import { ProtectionService } from './protection.service';
import { RealtimeService } from '../system/realtime.service';
import { NotificationOutboxService } from '../system/notification-outbox.service';
import { ExecutionCancelDto, ExecutionRetryDto, SourceGroupDto } from '../common/request-dtos';

@Controller('api')
export class ExecutionController {
  constructor(private readonly executions: ExecutionService, private readonly protection: ProtectionService, private readonly auth: AuthService, private readonly realtime: RealtimeService, private readonly outbox: NotificationOutboxService) {
    realtime.registerSnapshotProvider('executions', () => executions.list({ page: 1, pageSize: 15 }));
    realtime.registerSnapshotProvider('protection', () => protection.assess(new Date()));
    realtime.registerSnapshotProvider('notification_deliveries', () => this.deliveries());
  }
  @Get('executions')
  list(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.executions.list(req.query); }
  @Get('executions/:id')
  get(@Req() req: FastifyRequest, @Param('id') id: string) { const session = this.auth.requireSession(req); const view = this.executions.get(id); return session.role === 'admin' ? {...view,audit:this.executions.audit(id)} : view; }
  @Post('jobs/:id/executions')
  enqueue(@Req() req: FastifyRequest, @Param('id') id: string) { const session = this.auth.requireAdmin(req); return this.executions.enqueue(id,'manual',{userId:session.user_id}); }
  @Post('runs/:id/retry-execution')
  retryHistorical(@Req() req: FastifyRequest, @Param('id') id: string) { const session = this.auth.requireAdmin(req); return this.executions.retryHistoricalRun(id,{userId:session.user_id}); }
  @Post('executions/:id/retries')
  retry(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: ExecutionRetryDto) { const session = this.auth.requireAdmin(req); if (!Array.isArray(body?.pairs) || body.pairs.some(pair => !pair || typeof pair.connectionId !== 'string' || typeof pair.storageTargetId !== 'string')) throw new BadRequestException('Select valid execution pairs'); return this.executions.retry(id,body.pairs,{userId:session.user_id}); }
  @Post('executions/:id/cancel')
  cancel(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: ExecutionCancelDto) { const session = this.auth.requireAdmin(req); if (body?.stopRunningConfirmed !== undefined && typeof body.stopRunningConfirmed !== 'boolean') throw new BadRequestException('Invalid stop confirmation'); return this.executions.cancel(id,{userId:session.user_id},body?.stopRunningConfirmed === true); }
  @Post('executions/:id/priority')
  priority(@Req() req: FastifyRequest, @Param('id') id: string) { const session = this.auth.requireAdmin(req); return this.executions.moveAhead(id,{userId:session.user_id}); }
  @Get('protection')
  assess(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.protection.assess(new Date()); }
  @Get('source-groups')
  groups(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.executions.groups(); }
  @Post('source-groups')
  configureGroups(@Req() req: FastifyRequest, @Body() body: SourceGroupDto) {
    const session = this.auth.requireAdmin(req); const actor = {userId:session.user_id};
    if (body?.globalConcurrency !== undefined) {
      if (Object.keys(body).some(key => key !== 'globalConcurrency')) throw new BadRequestException('Submit global concurrency separately');
      this.executions.configure(body.globalConcurrency,actor);
    } else {
      if (!body || typeof body.name !== 'string' || !body.name.trim() || !Array.isArray(body.connectionIds) || body.connectionIds.some(id => typeof id !== 'string') || new Set(body.connectionIds).size !== body.connectionIds.length) throw new BadRequestException('Invalid source group');
      this.executions.assignGroup(body.connectionIds,body.id || crypto.randomUUID(),body.name.trim(),body.concurrency!,actor);
    }
    return this.executions.groups();
  }
  private deliveries() { return {items:this.outbox.list(),lastPollError:this.outbox.lastPollError}; }
  @Get('notification-deliveries')
  notificationDeliveries(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.deliveries(); }
}
