import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { StorageModule } from './storage/storage.module';
import { BackupModule } from './backup/backup.module';
import { AppController } from './app.controller';
import { SystemModule } from './system/system.module';

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule, AuthModule, StorageModule, BackupModule, SystemModule], controllers: [AppController] })
export class AppModule {}
