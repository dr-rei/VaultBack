import { NotificationOutboxService } from './notification-outbox.service';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';
import { RealtimeModule } from './realtime.module';
import { RealtimeController } from './realtime.controller';
import { AssetCacheController } from './asset-cache.controller';
import { AssetCacheService } from './asset-cache.service';

@Module({ imports: [AuthModule, RealtimeModule], providers: [SystemService, NotificationOutboxService, AssetCacheService], controllers: [SystemController, RealtimeController, AssetCacheController], exports: [SystemService, NotificationOutboxService, AssetCacheService, RealtimeModule] })
export class SystemModule {}
