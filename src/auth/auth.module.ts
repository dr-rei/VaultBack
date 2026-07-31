import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { RealtimeModule } from '../system/realtime.module';

@Module({ imports: [RealtimeModule], providers: [AuthService], controllers: [AuthController], exports: [AuthService] })
export class AuthModule {}
