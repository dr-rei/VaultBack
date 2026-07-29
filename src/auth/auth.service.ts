import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { FastifyRequest } from 'fastify';
import { environmentName, isProductionEnvironment, maxLoginSessionsPerUser, rateLimitPerMinute } from '../common/app-config';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class AuthService {
  constructor(private readonly store: DatabaseService) {}

  isSetupComplete() { return Boolean(this.store.db.prepare('SELECT id FROM users LIMIT 1').get()); }

  private claimInitialSetup() {
    const staleBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    this.store.db.prepare('DELETE FROM setup_claims WHERE id = 1 AND claimed_at <= ? AND NOT EXISTS (SELECT 1 FROM users)').run(staleBefore);
    const result = this.store.db.prepare('INSERT OR IGNORE INTO setup_claims (id, claimed_at) VALUES (1, ?)').run(this.store.now());
    if (Number((result as any).changes || 0) !== 1) {
      throw new BadRequestException(this.isSetupComplete() ? 'Setup has already been completed' : 'Initial setup is already in progress');
    }
  }

  private releaseInitialSetup() {
    this.store.db.prepare('DELETE FROM setup_claims WHERE id = 1').run();
  }

  async setup(username: string, password: string) {
    if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) throw new BadRequestException('Username must be 3-40 characters');
    if (password.length < 12) throw new BadRequestException('Use a password of at least 12 characters');
    this.claimInitialSetup();
    try {
      if (this.isSetupComplete()) throw new BadRequestException('Setup has already been completed');
      const id = crypto.randomUUID();
      const hash = await bcrypt.hash(password, 12);
      this.store.db.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(id, username, hash, 'admin', this.store.now());
      return this.createSession(id);
    } finally {
      this.releaseInitialSetup();
    }
  }

  async login(username: string, password: string) {
    const user = this.store.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as { id: string; password_hash: string; role?: string } | undefined;
    if (!user || !(await bcrypt.compare(password, user.password_hash))) throw new UnauthorizedException('Invalid credentials');
    this.store.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(this.store.now(), user.id);
    return this.createSession(user.id);
  }

  private maxLoginSessionsPerUser() {
    return maxLoginSessionsPerUser();
  }

  private enforceLoginSessionLimit(userId: string) {
    const maximum = this.maxLoginSessionsPerUser();
    if (maximum === 0) return;
    const now = this.store.now();
    this.store.db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').run(userId, now);
    const activeSessions = this.store.db.prepare('SELECT id FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC, id DESC').all(userId, now) as Array<{ id: string }>;
    const sessionsToRemove = activeSessions.slice(Math.max(0, maximum - 1));
    const removeSession = this.store.db.prepare('DELETE FROM sessions WHERE id = ?');
    for (const session of sessionsToRemove) removeSession.run(session.id);
  }

  private createSession(userId: string) {
    this.enforceLoginSessionLimit(userId);
    const id = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 12).toISOString();
    this.store.db.prepare('INSERT INTO sessions (id, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, csrfToken, expiresAt, this.store.now());
    return { id, csrfToken, expiresAt };
  }

  getSession(request: FastifyRequest) {
    const token = request.cookies?.vb_session;
    if (!token) return null;
    const session = this.store.db.prepare(`SELECT s.*, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`).get(token, this.store.now()) as { id: string; user_id: string; csrf_token: string; username: string; role: string } | undefined;
    return session || null;
  }

  requireSession(request: FastifyRequest, write = false) {
    const session = this.getSession(request);
    if (!session) throw new UnauthorizedException('Login required');
    if (write && request.headers['x-csrf-token'] !== session.csrf_token) throw new UnauthorizedException('CSRF validation failed');
    return session;
  }

  requireAdmin(request: FastifyRequest, write = request.method !== 'GET') {
    const session = this.requireSession(request, write);
    if (session.role !== 'admin') throw new ForbiddenException('Administrator permission required');
    return session;
  }

  private primaryUserId() {
    const user = this.store.db.prepare('SELECT id FROM users ORDER BY created_at ASC, rowid ASC LIMIT 1').get() as { id?: string } | undefined;
    return user?.id || null;
  }

  isPrimaryUser(id: string) { return id === this.primaryUserId(); }

  private withUserProtection(items: any[]) {
    const primaryId = this.primaryUserId();
    return items.map(user => ({ ...user, isPrimary: user.id === primaryId }));
  }

  listUsers() { return this.withUserProtection(this.store.db.prepare('SELECT id,username,role,created_at as createdAt,last_login_at as lastLoginAt FROM users ORDER BY username').all() as any[]); }
  listUsersPage(input: any = {}) { const page = Math.max(1, Number.parseInt(String(input.page || '1'), 10) || 1); const pageSize = Math.min(100, Math.max(10, Number.parseInt(String(input.pageSize || '25'), 10) || 25)); const offset = (page - 1) * pageSize; const search = String(input.search || '').trim().toLowerCase(); const where = search ? `WHERE LOWER(COALESCE(username,'') || ' ' || COALESCE(role,'')) LIKE ?` : ''; const params = search ? [`%${search}%`] : []; const total = Number((this.store.db.prepare(`SELECT COUNT(*) as count FROM users ${where}`).get(...params) as any)?.count || 0); const items = this.store.db.prepare(`SELECT id,username,role,created_at as createdAt,last_login_at as lastLoginAt FROM users ${where} ORDER BY username LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]; return { items: this.withUserProtection(items), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) }; }

  async createUser(username: string, password: string, role: string) {
    if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) throw new BadRequestException('Username must be 3-40 characters');
    if (password.length < 12) throw new BadRequestException('Use a password of at least 12 characters');
    if (!['admin', 'operator', 'viewer'].includes(role)) throw new BadRequestException('Unsupported user role');
    const hash = await bcrypt.hash(password, 12);
    this.store.db.prepare('INSERT INTO users (id,username,password_hash,role,created_at) VALUES (?,?,?,?,?)').run(crypto.randomUUID(), username, hash, role, this.store.now());
    return this.listUsers().find((user: any) => user.username === username);
  }

  async updateUser(id: string, username: string, password: string, role: string) {
    const target = this.store.db.prepare('SELECT id,username,password_hash as passwordHash,role FROM users WHERE id = ?').get(id) as { id: string; username: string; passwordHash: string; role: string } | undefined;
    if (!target) throw new NotFoundException('User account not found');
    if (id === this.primaryUserId()) throw new ForbiddenException('The first administrator is protected and cannot be modified');
    if (target.role === 'admin') throw new ForbiddenException('Administrators cannot modify another administrator account');
    if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) throw new BadRequestException('Username must be 3-40 characters');
    if (!['admin', 'operator', 'viewer'].includes(role)) throw new BadRequestException('Unsupported user role');
    if (password && password.length < 12) throw new BadRequestException('Use a password of at least 12 characters');
    const hash = password ? await bcrypt.hash(password, 12) : target.passwordHash;
    try {
      this.store.db.prepare('UPDATE users SET username = ?, password_hash = ?, role = ? WHERE id = ?').run(username, hash, role, id);
    } catch (error: any) {
      if (String(error?.message || '').toLowerCase().includes('unique')) throw new BadRequestException('That username is already in use');
      throw error;
    }
    return this.listUsers().find((user: any) => user.id === id);
  }

  deleteUser(id: string, currentUserId: string) {
    if (id === this.primaryUserId()) throw new ForbiddenException('The first administrator is protected and cannot be deleted');
    if (id === currentUserId) throw new BadRequestException('You cannot delete your own account');
    const target = this.store.db.prepare('SELECT role FROM users WHERE id=?').get(id) as { role?: string } | undefined;
    if (!target) throw new NotFoundException('User account not found');
    if (target.role === 'admin') throw new ForbiddenException('Administrators cannot delete another administrator account');
    this.store.db.prepare('DELETE FROM users WHERE id=?').run(id); return { ok: true };
  }

  private configuredRateLimit() {
    return rateLimitPerMinute();
  }

  listActiveSessions(request: FastifyRequest) {
    const currentToken = request.cookies?.vb_session || '';
    const query = (request as any).query || {};
    const page = Math.max(1, Number.parseInt(String(query.page || '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(10, Number.parseInt(String(query.pageSize || '25'), 10) || 25));
    this.store.db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR user_id NOT IN (SELECT id FROM users)').run(this.store.now());
    const total = Number((this.store.db.prepare('SELECT COUNT(*) as count FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.expires_at > ?').get(this.store.now()) as any)?.count || 0);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pageCount);
    const items = this.store.db.prepare(`
      SELECT s.user_id as userId, u.username, u.role,
             s.created_at as createdAt, s.expires_at as expiresAt,
             CASE WHEN s.id = ? THEN 1 ELSE 0 END as isCurrent
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.expires_at > ?
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ? OFFSET ?
    `).all(currentToken, this.store.now(), pageSize, (safePage - 1) * pageSize) as any[];
    return {
      items: items.map(item => ({ ...item, isCurrent: Boolean(item.isCurrent) })),
      total,
      page: safePage,
      pageSize,
      pageCount,
      rateLimit: {
        enabled: isProductionEnvironment(),
        environment: environmentName(),
        requestsPerMinute: this.configuredRateLimit(),
        authenticationAttempts: 10,
        authenticationWindowMinutes: 15,
        maxLoginSessionsPerUser: this.maxLoginSessionsPerUser(),
        scope: 'Per client IP address',
        storage: 'Server memory'
      }
    };
  }

  forceLogoutUser(targetUserId: string, actorUserId: string) {
    const target = this.store.db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(targetUserId) as { id: string; username: string; role: string } | undefined;
    if (!target) throw new NotFoundException('User account not found');
    const actorIsPrimary = actorUserId === this.primaryUserId();
    if (!actorIsPrimary && (target.role === 'admin' || target.role === '')) {
      throw new ForbiddenException('Only the first administrator can force logout an administrator');
    }
    const result = this.store.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetUserId);
    return { ok: true, username: target.username, sessionsClosed: Number((result as any).changes || 0) };
  }

  forceLogoutLowerRoles(actorUserId: string) {
    const actorIsPrimary = actorUserId === this.primaryUserId();
    const result = this.store.db.prepare(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role IN ('operator', 'viewer'))`).run();
    return { ok: true, sessionsClosed: Number((result as any).changes || 0), includesAdministrators: false, actorIsPrimary };
  }

  forceLogoutEveryone(actorUserId: string) {
    if (actorUserId !== this.primaryUserId()) throw new ForbiddenException('Only the first administrator can force logout everyone');
    const result = this.store.db.prepare('DELETE FROM sessions').run();
    return { ok: true, sessionsClosed: Number((result as any).changes || 0), includesAdministrators: true };
  }

  logout(request: FastifyRequest) {
    const token = request.cookies?.vb_session;
    if (token) this.store.db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
  }
}
