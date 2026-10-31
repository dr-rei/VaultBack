import { NotificationOutboxService } from './notification-outbox.service';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';
import { RealtimeModule } from './realtime.module';
import { RealtimeController } from './realtime.controller';

@Module({ imports: [AuthModule, RealtimeModule], providers: [SystemService, NotificationOutboxService], controllers: [SystemController, RealtimeController], exports: [SystemService, NotificationOutboxService, RealtimeModule] })
export class SystemModule {}
