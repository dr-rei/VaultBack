import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BackupModule } from '../backup/backup.module';
import { StorageModule } from '../storage/storage.module';
import { SystemModule } from '../system/system.module';
import { RecoveryController } from './recovery.controller';
import { RecoveryScheduler } from './recovery.scheduler';
import { RecoveryService } from './recovery.service';

@Module({ imports: [AuthModule, BackupModule, StorageModule, SystemModule], controllers: [RecoveryController], providers: [RecoveryService, RecoveryScheduler], exports: [RecoveryService] })
export class RecoveryModule {}
