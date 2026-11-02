import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import path from 'node:path';
import { AuthService } from '../auth/auth.service';
import { AssetCacheSettingsDto } from './asset-cache.dto';
import { AssetCacheService } from './asset-cache.service';
import { SystemService } from './system.service';

@Controller('api/settings/cache')
export class AssetCacheController {
  constructor(private readonly cache: AssetCacheService, private readonly auth: AuthService, private readonly system: SystemService) {}

  @Get()
  read(@Req() request: FastifyRequest) {
    this.auth.requireAdmin(request);
    return this.cache.settings(request.headers.host, path.resolve(process.cwd(), 'public'));
  }

  @Post()
  save(@Req() request: FastifyRequest, @Body() body: AssetCacheSettingsDto) {
    const session = this.auth.requireAdmin(request);
    this.cache.saveConfig(body);
    this.system.audit(session.user_id, 'settings.cache.update', undefined, undefined, {
      enabled: body.enabled,
      browserMaxAgeSeconds: body.browserMaxAgeSeconds,
      edgeMaxAgeSeconds: body.edgeMaxAgeSeconds
    });
    return this.cache.settings(request.headers.host, path.resolve(process.cwd(), 'public'));
  }
}
