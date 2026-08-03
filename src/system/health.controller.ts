import { Controller, Get, Injectable } from '@nestjs/common';
import { HealthCheck, HealthCheckService, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import { DatabaseService } from '../database/database.service';
import { SystemService } from './system.service';

@Injectable()
export class VaultbackHealthIndicator extends HealthIndicator {
  constructor(private readonly store: DatabaseService, private readonly system: SystemService) { super(); }

  checkDatabase(key: string): HealthIndicatorResult {
    try {
      this.store.db.prepare('SELECT 1').get();
      return this.getStatus(key, true);
    } catch (error: any) {
      return this.getStatus(key, false, { message: String(error?.message || error).slice(0, 180) });
    }
  }

  checkEncryption(key: string): HealthIndicatorResult {
    const status = this.store.encryptionStatus();
    return this.getStatus(key, status.status === 'ok', { checkedRecords: status.checkedRecords, checkedAt: status.checkedAt, message: status.message });
  }

  checkCapacity(key: string): HealthIndicatorResult {
    try {
      const capacity = this.system.capacity();
      const full = capacity.filter(item => Number(item.usedPercent || 0) >= 95);
      const summary = capacity.map(item => ({ name: item.name, usedPercent: item.usedPercent }));
      return this.getStatus(key, full.length === 0, { locations: summary, message: full.length ? 'One or more application locations are critically full' : 'Capacity is healthy' });
    } catch (error: any) {
      return this.getStatus(key, false, { message: String(error?.message || error).slice(0, 180) });
    }
  }
}

@Controller('api/health')
export class HealthController {
  constructor(private readonly health: HealthCheckService, private readonly indicator: VaultbackHealthIndicator, private readonly system: SystemService) {}

  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      () => this.indicator.checkDatabase('database'),
      () => this.indicator.checkEncryption('encryption'),
      () => this.indicator.checkCapacity('capacity')
    ]);
  }

  @Get()
  liveness() { return { ok: true, service: 'vaultback', version: this.system.getAppVersion(), time: new Date().toISOString() }; }

  @Get('live')
  live() { return this.liveness(); }
}
