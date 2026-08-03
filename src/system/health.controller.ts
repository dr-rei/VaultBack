import { Controller, Get, Injectable } from '@nestjs/common';
import { HealthCheck, HealthCheckService, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import { DatabaseService } from '../database/database.service';
import { SystemService } from './system.service';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiExampleResponse } from '../common/swagger-responses';

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
@ApiTags('Health checks')
export class HealthController {
  constructor(private readonly health: HealthCheckService, private readonly indicator: VaultbackHealthIndicator, private readonly system: SystemService) {}

  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Check database, encryption, and capacity readiness.' })
  @ApiExampleResponse(200, 'Readiness report.', { status: 'ok', info: { database: { status: 'up' }, encryption: { status: 'up', checkedRecords: 12 }, capacity: { status: 'up', locations: [] } }, error: {}, details: { database: { status: 'up' }, encryption: { status: 'up', checkedRecords: 12 }, capacity: { status: 'up', locations: [] } } })
  readiness() {
    return this.health.check([
      () => this.indicator.checkDatabase('database'),
      () => this.indicator.checkEncryption('encryption'),
      () => this.indicator.checkCapacity('capacity')
    ]);
  }

  @Get()
  @ApiOperation({ summary: 'Check whether the service is alive.' })
  @ApiExampleResponse(200, 'Liveness response.', { ok: true, service: 'vaultback', version: '0.1.27', time: '2026-08-03T07:30:00.000Z' })
  liveness() { return { ok: true, service: 'vaultback', version: this.system.getAppVersion(), time: new Date().toISOString() }; }

  @Get('live')
  @ApiOperation({ summary: 'Alias for the liveness check.' })
  @ApiExampleResponse(200, 'Liveness response.', { ok: true, service: 'vaultback', version: '0.1.27', time: '2026-08-03T07:30:00.000Z' })
  live() { return this.liveness(); }
}
