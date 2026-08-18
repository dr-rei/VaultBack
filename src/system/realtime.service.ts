import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ServerResponse } from 'node:http';

export type RealtimeTopic = 'processes' | 'backup_runs' | 'sessions' | 'rate_limit' | 'updates' | 'storage_health' | 'downloads' | 'recovery_tests';
type Role = 'admin' | 'operator' | 'viewer' | string;
type Connection = {
  id: string;
  userId: string;
  role: Role;
  ip: string;
  sessionToken: string;
  query: Record<string, string>;
  response: ServerResponse;
  topics: Set<RealtimeTopic>;
  heartbeat: ReturnType<typeof setInterval>;
  connectedAt: number;
};
export type RealtimeSnapshotContext = { userId: string; role: Role; ip: string; sessionToken: string; query: Record<string, string> };
type SnapshotProvider = (context: RealtimeSnapshotContext) => unknown;

@Injectable()
export class RealtimeService implements OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<RealtimeTopic, { payload: unknown; timer: ReturnType<typeof setTimeout> }>();
  private readonly snapshots = new Map<RealtimeTopic, SnapshotProvider>();
  private readonly snapshotTimer: ReturnType<typeof setInterval>;
  private sequence = 0;
  private readonly maxConnectionsPerUser = 5;
  private readonly maxConnectionsPerIp = 20;

  constructor() {
    this.snapshotTimer = setInterval(() => this.pushSnapshots(), 2000);
    this.snapshotTimer.unref?.();
  }

  allowedTopics(role: Role): RealtimeTopic[] {
    const common: RealtimeTopic[] = ['processes', 'backup_runs', 'storage_health', 'downloads'];
    return role === 'admin' ? [...common, 'sessions', 'rate_limit', 'updates', 'recovery_tests'] : common;
  }

  connect(response: ServerResponse, userId: string, role: Role, ip: string, sessionToken: string, requestedTopics: string[] = [], query: Record<string, string> = {}) {
    const allowed = new Set(this.allowedTopics(role));
    const topics = new Set<RealtimeTopic>(requestedTopics.filter((topic): topic is RealtimeTopic => allowed.has(topic as RealtimeTopic)));
    if (!topics.size) for (const topic of allowed) topics.add(topic);

    const existing = [...this.connections.values()].filter(connection => connection.userId === userId).sort((a, b) => a.connectedAt - b.connectedAt);
    for (const connection of existing.slice(0, Math.max(0, existing.length - this.maxConnectionsPerUser + 1))) this.close(connection.id);
    const byIp = [...this.connections.values()].filter(connection => connection.ip === ip).sort((a, b) => a.connectedAt - b.connectedAt);
    for (const connection of byIp.slice(0, Math.max(0, byIp.length - this.maxConnectionsPerIp + 1))) this.close(connection.id);

    const id = `${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    const connection: Connection = {
      id,
      userId,
      role,
      ip,
      sessionToken,
      query,
      response,
      topics,
      heartbeat: setInterval(() => {
        if (!this.writeRaw(connection, ': heartbeat\n\n')) this.close(id);
      }, 25000),
      connectedAt: Date.now()
    };
    connection.heartbeat.unref?.();
    this.connections.set(id, connection);
    response.once('close', () => this.close(id));
    response.once('error', () => this.close(id));
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff'
    });
    response.flushHeaders?.();
    this.writeEvent(connection, 'connected', { topics: [...topics], reconnect: true });
    return id;
  }

  publish(topic: RealtimeTopic, payload: unknown) {
    for (const connection of this.connections.values()) {
      if (!connection.topics.has(topic)) continue;
      if (!this.writeEvent(connection, topic, payload)) this.close(connection.id);
    }
  }

  publishToUser(topic: RealtimeTopic, userId: string, payload: unknown) {
    for (const connection of this.connections.values()) {
      if (connection.userId !== userId || !connection.topics.has(topic)) continue;
      if (!this.writeEvent(connection, topic, payload)) this.close(connection.id);
    }
  }

  publishThrottled(topic: RealtimeTopic, payload: unknown, delayMs = 500) {
    const current = this.pending.get(topic);
    if (current) {
      current.payload = payload;
      return;
    }
    const timer = setTimeout(() => {
      const pending = this.pending.get(topic);
      this.pending.delete(topic);
      if (pending) this.publish(topic, pending.payload);
    }, delayMs);
    timer.unref?.();
    this.pending.set(topic, { payload, timer });
  }

  disconnectUser(userId: string) {
    for (const connection of this.connections.values()) if (connection.userId === userId) this.close(connection.id);
  }

  disconnectAll() {
    for (const connection of this.connections.values()) this.close(connection.id);
  }

  connectionCount() { return this.connections.size; }

  onApplicationShutdown() {
    clearInterval(this.snapshotTimer);
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    this.disconnectAll();
  }

  registerSnapshotProvider(topic: RealtimeTopic, provider: SnapshotProvider) { this.snapshots.set(topic, provider); }

  private pushSnapshots() {
    for (const connection of this.connections.values()) {
      for (const topic of connection.topics) {
        const provider = this.snapshots.get(topic);
        if (!provider) continue;
        try {
          const payload = provider({ userId: connection.userId, role: connection.role, ip: connection.ip, sessionToken: connection.sessionToken, query: connection.query });
          if (payload && !this.writeEvent(connection, topic, payload)) this.close(connection.id);
        } catch (error: any) {
          this.logger.debug(`Realtime snapshot failed for ${topic}: ${String(error?.message || error).slice(0, 160)}`);
        }
      }
    }
  }

  private writeEvent(connection: Connection, event: string, payload: unknown) {
    return this.writeRaw(connection, `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  private writeRaw(connection: Connection, value: string) {
    try {
      if (connection.response.writableEnded || connection.response.destroyed) return false;
      connection.response.write(value);
      return true;
    } catch (error: any) {
      this.logger.debug(`Realtime connection ${connection.id} closed: ${String(error?.message || error).slice(0, 120)}`);
      return false;
    }
  }

  private close(id: string) {
    const connection = this.connections.get(id);
    if (!connection) return;
    this.connections.delete(id);
    clearInterval(connection.heartbeat);
    try { if (!connection.response.writableEnded) connection.response.end(); } catch {}
  }
}
