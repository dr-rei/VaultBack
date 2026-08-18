import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RecoveryService } from './recovery.service';

@Injectable()
export class RecoveryScheduler {
  constructor(private readonly recovery: RecoveryService) {}
  @Cron('15 * * * * *') tick() { return this.recovery.runDue(); }
}
