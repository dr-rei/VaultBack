import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service';
import { StorageService } from './storage.service';
import { StorageTargetDto } from '../common/request-dtos';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

@Controller('api/storage')
@ApiTags('Storage targets')
@ApiCookieAuth('vb_session')
export class StorageController {
  constructor(private readonly storage: StorageService, private readonly auth: AuthService) {}
  @Get()
  @ApiOperation({ summary: 'List storage targets with search and pagination.' })
  list(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.storage.listPage((req as any).query || {}); }
  @Post()
  @ApiOperation({ summary: 'Create or update an encrypted storage target.' })
  save(@Req() req: FastifyRequest, @Body() body: StorageTargetDto) { this.auth.requireAdmin(req); return this.storage.save(body); }
  @Post(':id/test')
  @ApiParam({ name: 'id', description: 'Storage target ID.' })
  @ApiOperation({ summary: 'Test connectivity to a storage target.' })
  async test(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.storage.test(this.storage.get(id)); }
  @Get('health')
  @ApiOperation({ summary: 'Read the health summary for all storage targets.' })
  healthSummary(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.storage.healthSummary(); }
  @Post(':id/health')
  @ApiParam({ name: 'id', description: 'Storage target ID.' })
  @ApiOperation({ summary: 'Run a health check for one storage target.' })
  async health(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.storage.health(this.storage.get(id)); }
  @Delete(':id')
  @ApiParam({ name: 'id', description: 'Storage target ID.' })
  @ApiOperation({ summary: 'Delete a storage target.' })
  delete(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.storage.delete(id); }
}
