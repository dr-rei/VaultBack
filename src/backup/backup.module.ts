import { ExecutionController } from './execution.controller';
import { ProtectionService } from './protection.service';
import { ExecutionService } from './execution.service';
import { ExecutionStore } from './execution.store';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BackupService } from './backup.service';
import { BackupController } from './backup.controller';
import { BackupScheduler } from './backup.scheduler';
import { StorageModule } from '../storage/storage.module';
import { AuthModule } from '../auth/auth.module';
import { SystemModule } from '../system/system.module';
import { ToolInstallerService } from './tool-installer.service';

@Module({ imports: [ScheduleModule.forRoot(), StorageModule, AuthModule, SystemModule], providers: [ProtectionService, ExecutionService, ExecutionStore, BackupService, BackupScheduler, ToolInstallerService], controllers: [BackupController, ExecutionController], exports: [ProtectionService, BackupService, ExecutionService, ExecutionStore] })
export class BackupModule {}
