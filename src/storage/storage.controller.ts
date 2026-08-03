import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service';
import { StorageService } from './storage.service';
import { StorageTargetDto } from '../common/request-dtos';

@Controller('api/storage')
export class StorageController {
  constructor(private readonly storage: StorageService, private readonly auth: AuthService) {}
  @Get() list(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.storage.listPage((req as any).query || {}); }
  @Post() save(@Req() req: FastifyRequest, @Body() body: StorageTargetDto) { this.auth.requireAdmin(req); return this.storage.save(body); }
  @Post(':id/test') async test(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.storage.test(this.storage.get(id)); }
  @Get('health') healthSummary(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.storage.healthSummary(); }
  @Post(':id/health') async health(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.storage.health(this.storage.get(id)); }
  @Delete(':id') delete(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.storage.delete(id); }
}
