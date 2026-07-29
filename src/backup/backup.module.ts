import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BackupService } from './backup.service';
import { BackupController } from './backup.controller';
import { BackupScheduler } from './backup.scheduler';
import { StorageModule } from '../storage/storage.module';
import { AuthModule } from '../auth/auth.module';
import { SystemModule } from '../system/system.module';
import { ToolInstallerService } from './tool-installer.service';

@Module({ imports: [ScheduleModule.forRoot(), StorageModule, AuthModule, SystemModule], providers: [BackupService, BackupScheduler, ToolInstallerService], controllers: [BackupController], exports: [BackupService] })
export class BackupModule {}
