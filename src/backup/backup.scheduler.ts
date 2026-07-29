import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BackupService } from './backup.service';
import { SystemService } from '../system/system.service';

@Injectable()
export class BackupScheduler {
  constructor(private readonly backups: BackupService, private readonly system: SystemService) {}
  @Cron('0 * * * * *') tick() { return this.backups.runDue(); }
  @Cron('0 */15 * * * *') capacityCheck() { for (const item of this.system.capacity()) if (item.usedPercent !== null && item.usedPercent >= 85) void this.system.notify('capacity_warning', `VaultBack storage warning: ${item.name} is ${item.usedPercent}% full.`); }
}
