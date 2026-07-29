import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';

@Module({ imports: [AuthModule], providers: [SystemService], controllers: [SystemController], exports: [SystemService] })
export class SystemModule {}
