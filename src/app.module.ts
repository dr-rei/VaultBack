import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { StorageModule } from './storage/storage.module';
import { BackupModule } from './backup/backup.module';
import { AppController } from './app.controller';
import { SystemModule } from './system/system.module';
import { CommonModule } from './common/common.module';
import { RequestContextMiddleware } from './common/request-context.middleware';
import { HealthController } from './system/health.controller';
import { TerminusModule } from '@nestjs/terminus';
import { VaultbackHealthIndicator } from './system/health.controller';

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true, cache: true }), TerminusModule, CommonModule, DatabaseModule, AuthModule, StorageModule, BackupModule, SystemModule], controllers: [AppController, HealthController], providers: [VaultbackHealthIndicator] })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
