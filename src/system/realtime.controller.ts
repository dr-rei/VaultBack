import { Controller, Get, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { RealtimeService } from './realtime.service';
import { AuthService } from '../auth/auth.service';
import { SystemService } from './system.service';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrorResponses, ApiEventStreamResponse } from '../common/swagger-responses';

@Controller('api')
@ApiTags('Realtime events')
@ApiCookieAuth('vb_session')
@ApiCommonErrorResponses()
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService, private readonly auth: AuthService, private readonly system: SystemService) {
    this.realtime.registerSnapshotProvider('sessions', context => this.auth.listActiveSessions({ cookies: { vb_session: context.sessionToken }, query: { page: context.query.sessionPage || '1', pageSize: context.query.sessionPageSize || '25' } } as any));
    this.realtime.registerSnapshotProvider('rate_limit', context => this.system.listApiUsage({ page: context.query.ratePage || '1', pageSize: context.query.ratePageSize || '25' }));
    this.realtime.registerSnapshotProvider('updates', () => this.system.updateInfo());
  }

  @Get('events')
  @ApiOperation({ summary: 'Open the authenticated server-sent event stream.' })
  @ApiEventStreamResponse()
  events(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const session = this.auth.requireSession(request);
    const rawTopics = String((request as any).query?.topics || '').split(',').map(value => value.trim()).filter(Boolean);
    const requestQuery = (request as any).query || {};
    const query = Object.fromEntries(Object.entries(requestQuery).map(([key, value]) => [key, String(value ?? '')]));
    reply.hijack();
    this.realtime.connect(reply.raw, session.user_id, session.role, String(request.ip || request.socket?.remoteAddress || 'unknown'), String(request.cookies?.vb_session || ''), rawTopics, query);
    return undefined;
  }
}
