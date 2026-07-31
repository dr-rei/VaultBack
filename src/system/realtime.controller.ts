import { Controller, Get, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { RealtimeService } from './realtime.service';
import { AuthService } from '../auth/auth.service';
import { SystemService } from './system.service';

@Controller('api')
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService, private readonly auth: AuthService, private readonly system: SystemService) {
    this.realtime.registerSnapshotProvider('sessions', context => this.auth.listActiveSessions({ cookies: { vb_session: context.sessionToken }, query: { page: 1, pageSize: 100 } } as any));
    this.realtime.registerSnapshotProvider('rate_limit', () => this.system.listApiUsage({ page: 1, pageSize: 100 }));
    this.realtime.registerSnapshotProvider('updates', () => this.system.updateInfo());
  }

  @Get('events') events(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const session = this.auth.requireSession(request);
    const rawTopics = String((request as any).query?.topics || '').split(',').map(value => value.trim()).filter(Boolean);
    reply.hijack();
    this.realtime.connect(reply.raw, session.user_id, session.role, String(request.ip || request.socket?.remoteAddress || 'unknown'), String(request.cookies?.vb_session || ''), rawTopics);
    return undefined;
  }
}
