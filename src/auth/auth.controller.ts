import { Body, Controller, Delete, Get, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { RealtimeService } from '../system/realtime.service';
import { isProductionEnvironment } from '../common/app-config';
import { CredentialsDto, UserDto } from '../common/request-dtos';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrorResponses, ApiExampleResponse } from '../common/swagger-responses';

@Controller('api/auth')
@ApiTags('Authentication and users')
@ApiCommonErrorResponses()
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly realtime: RealtimeService) {}

  @Get('status')
  @ApiOperation({ summary: 'Check whether initial administrator setup is complete.' })
  @ApiResponse({ status: 200, description: 'Setup status.', schema: { example: { setupComplete: true } } })
  status() { return { setupComplete: this.auth.isSetupComplete() }; }

  @Post('setup')
  @ApiOperation({ summary: 'Create the first administrator and start a session.' })
  @ApiResponse({ status: 201, description: 'Administrator created; the session cookie is set.', schema: { example: { ok: true, csrfToken: 'csrf-token-value' } } })
  async setup(@Body() body: CredentialsDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const session = await this.auth.setup(body.username || '', body.password || '');
    this.setCookie(reply, session.id);
    return { ok: true, csrfToken: session.csrfToken };
  }

  @Post('login')
  @ApiOperation({ summary: 'Authenticate a user and start a session.' })
  @ApiResponse({ status: 201, description: 'Authenticated; the session cookie is set.', schema: { example: { ok: true, csrfToken: 'csrf-token-value' } } })
  @ApiResponse({ status: 401, description: 'Invalid credentials or login is not available.' })
  async login(@Body() body: CredentialsDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const session = await this.auth.login(body.username || '', body.password || '');
    this.setCookie(reply, session.id);
    return { ok: true, csrfToken: session.csrfToken };
  }

  @Post('logout')
  @ApiCookieAuth('vb_session')
  @ApiOperation({ summary: 'End the current user session.' })
  @ApiExampleResponse(200, 'Session ended and the session cookie was cleared.', { ok: true })
  logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const session = this.auth.requireSession(request, true); this.auth.logout(request); this.realtime.disconnectUser(session.user_id); reply.clearCookie('vb_session', { path: '/' }); return { ok: true };
  }

  @Get('me')
  @ApiCookieAuth('vb_session')
  @ApiOperation({ summary: 'Return the current user and CSRF session information.' })
  @ApiExampleResponse(200, 'Current authenticated user and CSRF token.', { userId: 'user_01HXYZ123', username: 'admin', role: 'admin', isPrimary: true, csrfToken: 'csrf-token-value' })
  me(@Req() request: FastifyRequest) {
    const session = this.auth.requireSession(request); return { userId: session.user_id, username: session.username, role: session.role, isPrimary: this.auth.isPrimaryUser(session.user_id), csrfToken: session.csrf_token };
  }

  @Get('users')
  @ApiCookieAuth('vb_session')
  @ApiOperation({ summary: 'List users with pagination and search.' })
  @ApiExampleResponse(200, 'Paginated user accounts.', { items: [{ id: 'user_01HXYZ123', username: 'admin', role: 'admin', createdAt: '2026-08-03T07:00:00.000Z', lastLoginAt: '2026-08-03T07:30:00.000Z', isPrimary: true }], total: 1, page: 1, pageSize: 25, pageCount: 1 })
  users(@Req() request: FastifyRequest) { this.auth.requireAdmin(request); return this.auth.listUsersPage((request as any).query || {}); }
  @Post('users')
  @ApiCookieAuth('vb_session')
  @ApiOperation({ summary: 'Create a user account.' })
  @ApiExampleResponse(201, 'User account created.', { id: 'user_01HXYZ456', username: 'operator-one', role: 'operator', createdAt: '2026-08-03T07:00:00.000Z', lastLoginAt: null, isPrimary: false })
  async createUser(@Req() request: FastifyRequest, @Body() body: UserDto) { this.auth.requireAdmin(request); return this.auth.createUser(body.username || '', body.password || '', body.role || 'operator'); }
  @Patch('users/:id')
  @ApiCookieAuth('vb_session')
  @ApiParam({ name: 'id', description: 'User ID.' })
  @ApiOperation({ summary: 'Update a user account subject to role permissions.' })
  @ApiExampleResponse(200, 'User account updated.', { id: 'user_01HXYZ456', username: 'operator-one', role: 'viewer', createdAt: '2026-08-03T07:00:00.000Z', lastLoginAt: null, isPrimary: false })
  async updateUser(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: UserDto) { this.auth.requireAdmin(request); return this.auth.updateUser(id, body.username || '', body.password || '', body.role || 'operator'); }
  @Delete('users/:id')
  @ApiCookieAuth('vb_session')
  @ApiParam({ name: 'id', description: 'User ID.' })
  @ApiOperation({ summary: 'Delete a user account.' })
  @ApiExampleResponse(200, 'User account deleted.', { ok: true })
  deleteUser(@Req() request: FastifyRequest, @Param('id') id: string) { const session = this.auth.requireAdmin(request); return this.auth.deleteUser(id, session.user_id); }
  @Get('sessions')
  @ApiCookieAuth('vb_session')
  @ApiOperation({ summary: 'List active administrator-visible sessions.' })
  @ApiExampleResponse(200, 'Paginated active sessions and rate-limit configuration.', { items: [{ userId: 'user_01HXYZ123', username: 'admin', role: 'admin', createdAt: '2026-08-03T07:00:00.000Z', expiresAt: '2026-08-03T19:00:00.000Z', isCurrent: true }], total: 1, page: 1, pageSize: 25, pageCount: 1, rateLimit: { enabled: true, environment: 'production', requestsPerMinute: 800, authenticationAttempts: 10, authenticationWindowMinutes: 15, maxLoginSessionsPerUser: 0, scope: 'Per client IP address', storage: 'Server memory' } })
  sessions(@Req() request: FastifyRequest) { this.auth.requireAdmin(request); return this.auth.listActiveSessions(request); }
  @Post('sessions/logout-lower')
  @ApiCookieAuth('vb_session')
  @ApiOperation({ summary: 'Force logout of operator and viewer sessions.' })
  @ApiExampleResponse(201, 'Operator and viewer sessions closed.', { ok: true, sessionsClosed: 2, includesAdministrators: false, actorIsPrimary: true })
  logoutLowerSessions(@Req() request: FastifyRequest) { const session = this.auth.requireAdmin(request); const result = this.auth.forceLogoutLowerRoles(session.user_id); this.realtime.publish('sessions', { reason: 'sessions_changed' }); return result; }
  @Post('sessions/logout-all')
  @ApiCookieAuth('vb_session')
  @ApiOperation({ summary: 'Force logout of every session. Primary administrator only.' })
  @ApiExampleResponse(201, 'All sessions closed.', { ok: true, sessionsClosed: 3, includesAdministrators: true })
  logoutAllSessions(@Req() request: FastifyRequest) { const session = this.auth.requireAdmin(request); const result = this.auth.forceLogoutEveryone(session.user_id); this.realtime.disconnectAll(); return result; }
  @Post('users/:id/logout-sessions')
  @ApiCookieAuth('vb_session')
  @ApiParam({ name: 'id', description: 'User ID whose sessions should be revoked.' })
  @ApiOperation({ summary: 'Force logout of one user.' })
  @ApiExampleResponse(201, 'All sessions belonging to the selected user were closed.', { ok: true, username: 'operator-one', sessionsClosed: 1 })
  logoutUserSessions(@Req() request: FastifyRequest, @Param('id') id: string) { const session = this.auth.requireAdmin(request); const result = this.auth.forceLogoutUser(id, session.user_id); this.realtime.disconnectUser(id); this.realtime.publish('sessions', { reason: 'sessions_changed' }); return result; }

  private setCookie(reply: FastifyReply, value: string) {
    reply.setCookie('vb_session', value, { httpOnly: true, sameSite: 'strict', secure: isProductionEnvironment(), path: '/', maxAge: 60 * 60 * 12 });
  }
}
