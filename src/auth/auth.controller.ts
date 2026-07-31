import { Body, Controller, Delete, Get, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { RealtimeService } from '../system/realtime.service';
import { isProductionEnvironment } from '../common/app-config';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly realtime: RealtimeService) {}

  @Get('status') status() { return { setupComplete: this.auth.isSetupComplete() }; }

  @Post('setup') async setup(@Body() body: { username?: string; password?: string }, @Res({ passthrough: true }) reply: FastifyReply) {
    const session = await this.auth.setup(body.username || '', body.password || '');
    this.setCookie(reply, session.id);
    return { ok: true, csrfToken: session.csrfToken };
  }

  @Post('login') async login(@Body() body: { username?: string; password?: string }, @Res({ passthrough: true }) reply: FastifyReply) {
    const session = await this.auth.login(body.username || '', body.password || '');
    this.setCookie(reply, session.id);
    return { ok: true, csrfToken: session.csrfToken };
  }

  @Post('logout') logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const session = this.auth.requireSession(request, true); this.auth.logout(request); this.realtime.disconnectUser(session.user_id); reply.clearCookie('vb_session', { path: '/' }); return { ok: true };
  }

  @Get('me') me(@Req() request: FastifyRequest) {
    const session = this.auth.requireSession(request); return { userId: session.user_id, username: session.username, role: session.role, isPrimary: this.auth.isPrimaryUser(session.user_id), csrfToken: session.csrf_token };
  }

  @Get('users') users(@Req() request: FastifyRequest) { this.auth.requireAdmin(request); return this.auth.listUsersPage((request as any).query || {}); }
  @Post('users') async createUser(@Req() request: FastifyRequest, @Body() body: { username?: string; password?: string; role?: string }) { this.auth.requireAdmin(request); return this.auth.createUser(body.username || '', body.password || '', body.role || 'operator'); }
  @Patch('users/:id') async updateUser(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: { username?: string; password?: string; role?: string }) { this.auth.requireAdmin(request); return this.auth.updateUser(id, body.username || '', body.password || '', body.role || 'operator'); }
  @Delete('users/:id') deleteUser(@Req() request: FastifyRequest, @Param('id') id: string) { const session = this.auth.requireAdmin(request); return this.auth.deleteUser(id, session.user_id); }
  @Get('sessions') sessions(@Req() request: FastifyRequest) { this.auth.requireAdmin(request); return this.auth.listActiveSessions(request); }
  @Post('sessions/logout-lower') logoutLowerSessions(@Req() request: FastifyRequest) { const session = this.auth.requireAdmin(request); const result = this.auth.forceLogoutLowerRoles(session.user_id); this.realtime.publish('sessions', { reason: 'sessions_changed' }); return result; }
  @Post('sessions/logout-all') logoutAllSessions(@Req() request: FastifyRequest) { const session = this.auth.requireAdmin(request); const result = this.auth.forceLogoutEveryone(session.user_id); this.realtime.disconnectAll(); return result; }
  @Post('users/:id/logout-sessions') logoutUserSessions(@Req() request: FastifyRequest, @Param('id') id: string) { const session = this.auth.requireAdmin(request); const result = this.auth.forceLogoutUser(id, session.user_id); this.realtime.disconnectUser(id); this.realtime.publish('sessions', { reason: 'sessions_changed' }); return result; }

  private setCookie(reply: FastifyReply, value: string) {
    reply.setCookie('vb_session', value, { httpOnly: true, sameSite: 'strict', secure: isProductionEnvironment(), path: '/', maxAge: 60 * 60 * 12 });
  }
}
